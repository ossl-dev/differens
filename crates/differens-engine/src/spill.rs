//! Append-only candidate storage. AST payloads and lookup indexes live on disk;
//! an iterator opens one bucket at a time and never retains all candidate bytes.

use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use differens_core::{FlatSnapshot, NodeRef};
use differens_correlate::{CandidateGroup, CandidateIndices, CandidateMeta, CandidateStore};
use tempfile::TempDir;

use crate::{Error, Result};

const INDEX_BYTES: u64 = 40;
const INDEX_RECORD_BYTES: usize = 40;
const WRITE_BUFFER_BYTES: usize = 64 * 1024;

pub(crate) struct CandidateSpool {
    directory: TempDir,
    payloads: RefCell<File>,
    metadata: RefCell<File>,
    index: RefCell<File>,
    count: usize,
}

fn storage(error: io::Error) -> Error {
    Error::Spill(error)
}

fn create(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(storage)
}

fn write_record(writer: &mut impl Write, value: &impl serde::Serialize) -> Result<()> {
    let mut buffered = BufWriter::with_capacity(WRITE_BUFFER_BYTES, writer);
    serde_json::to_writer(&mut buffered, value).map_err(|error| {
        let kind = error.io_error_kind().unwrap_or(io::ErrorKind::InvalidData);
        storage(io::Error::new(kind, error))
    })?;
    buffered.flush().map_err(storage)
}

impl CandidateSpool {
    pub(crate) fn new() -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("differens-candidates-")
            .tempdir()
            .map_err(storage)?;
        let payloads = RefCell::new(create(&directory.path().join("payloads"))?);
        let metadata = RefCell::new(create(&directory.path().join("metadata"))?);
        let index = RefCell::new(create(&directory.path().join("index"))?);
        create(&directory.path().join("groups"))?;
        Ok(Self {
            directory,
            payloads,
            metadata,
            index,
            count: 0,
        })
    }

    pub(crate) fn push_meta(&mut self, meta: &CandidateMeta, node: &NodeRef) -> Result<()> {
        let mut payloads = self.payloads.borrow_mut();
        let payload_start = payloads.seek(SeekFrom::End(0)).map_err(storage)?;
        write_record(&mut *payloads, &node.snapshot())?;
        let payload_end = payloads.stream_position().map_err(storage)?;
        let mut metadata = self.metadata.borrow_mut();
        let meta_start = metadata.seek(SeekFrom::End(0)).map_err(storage)?;
        write_record(&mut *metadata, meta)?;
        let meta_end = metadata.stream_position().map_err(storage)?;
        let mut record = [0u8; INDEX_RECORD_BYTES];
        for (slot, number) in record.chunks_exact_mut(8).zip([
            payload_start,
            payload_end - payload_start,
            meta_start,
            meta_end - meta_start,
            0,
        ]) {
            slot.copy_from_slice(&number.to_le_bytes());
        }
        self.index
            .borrow_mut()
            .seek(SeekFrom::End(0))
            .map_err(storage)?;
        self.index
            .borrow_mut()
            .write_all(&record)
            .map_err(storage)?;
        if meta.deleted {
            self.append_bucket(CandidateGroup::Deletions(meta.structure_hash), self.count)?;
        } else {
            self.append_bucket(CandidateGroup::Insertions(meta.structure_hash), self.count)?;
            self.append_bucket(CandidateGroup::ExactInsertions(meta.exact_key), self.count)?;
            self.append_index(
                self.named_path(meta.structure_hash, meta.label.as_deref()),
                self.count,
                None,
            )?;
        }
        self.count += 1;
        Ok(())
    }

    fn bucket_path(&self, group: CandidateGroup) -> PathBuf {
        let (kind, hash) = match group {
            CandidateGroup::Deletions(hash) => ("d", hash),
            CandidateGroup::Insertions(hash) => ("i", hash),
            CandidateGroup::ExactInsertions(hash) => ("e", hash),
        };
        self.directory.path().join(format!("{kind}-{hash:016x}"))
    }

    fn append_bucket(&self, group: CandidateGroup, candidate: usize) -> Result<()> {
        let group_hash = match group {
            CandidateGroup::Deletions(hash) => Some(hash),
            _ => None,
        };
        self.append_index(self.bucket_path(group), candidate, group_hash)
    }

    fn named_path(&self, structure_hash: u64, label: Option<&str>) -> PathBuf {
        self.directory.path().join(format!(
            "n-{structure_hash:016x}-{:016x}",
            super::candidates::name_hash(label)
        ))
    }

    fn append_index(&self, path: PathBuf, candidate: usize, group_hash: Option<u64>) -> Result<()> {
        let bucket = OpenOptions::new().write(true).create_new(true).open(&path);
        let mut bucket = match bucket {
            Ok(bucket) => {
                if let Some(hash) = group_hash {
                    OpenOptions::new()
                        .append(true)
                        .open(self.directory.path().join("groups"))
                        .map_err(storage)?
                        .write_all(&hash.to_le_bytes())
                        .map_err(storage)?;
                }
                bucket
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => OpenOptions::new()
                .append(true)
                .open(path)
                .map_err(storage)?,
            Err(error) => return Err(storage(error)),
        };
        let candidate =
            u64::try_from(candidate).map_err(|error| storage(io::Error::other(error)))?;
        bucket.write_all(&candidate.to_le_bytes()).map_err(storage)
    }

    fn record(&self, candidate: usize) -> Result<[u64; 5]> {
        if candidate >= self.count {
            return Err(storage(io::Error::new(
                io::ErrorKind::InvalidInput,
                "candidate index out of range",
            )));
        }
        let offset = u64::try_from(candidate)
            .ok()
            .and_then(|candidate| candidate.checked_mul(INDEX_BYTES))
            .ok_or_else(|| storage(io::Error::other("candidate index overflow")))?;
        let mut bytes = [0u8; INDEX_RECORD_BYTES];
        let mut file = self.index.borrow_mut();
        file.seek(SeekFrom::Start(offset)).map_err(storage)?;
        file.read_exact(&mut bytes).map_err(storage)?;
        let mut values = [0; 5];
        for (value, chunk) in values.iter_mut().zip(bytes.chunks_exact(8)) {
            let mut number = [0; 8];
            number.copy_from_slice(chunk);
            *value = u64::from_le_bytes(number);
        }
        Ok(values)
    }
}

struct Numbers {
    reader: BufReader<File>,
    ended: bool,
}

impl Iterator for Numbers {
    type Item = Result<u64>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.ended {
            return None;
        }
        let mut bytes = [0; 8];
        match self.reader.read(&mut bytes[..1]) {
            Ok(0) => {
                self.ended = true;
                return None;
            }
            Ok(_) => {}
            Err(error) => {
                self.ended = true;
                return Some(Err(storage(error)));
            }
        }
        Some(
            self.reader
                .read_exact(&mut bytes[1..])
                .map(|()| u64::from_le_bytes(bytes))
                .map_err(storage),
        )
    }
}

fn numbers(path: &Path, optional: bool) -> Result<Box<dyn Iterator<Item = Result<u64>>>> {
    match File::open(path) {
        Ok(file) => Ok(Box::new(Numbers {
            reader: BufReader::new(file),
            ended: false,
        })),
        Err(error) if optional && error.kind() == io::ErrorKind::NotFound => {
            Ok(Box::new(std::iter::empty()))
        }
        Err(error) => Err(storage(error)),
    }
}

impl CandidateStore for CandidateSpool {
    type Error = Error;
    fn len(&self) -> usize {
        self.count
    }
    fn metadata(&self, candidate: usize) -> Result<CandidateMeta> {
        let [_, _, offset, length, _] = self.record(candidate)?;
        let mut file = self.metadata.borrow_mut();
        file.seek(SeekFrom::Start(offset)).map_err(storage)?;
        serde_json::from_reader(BufReader::new((&mut *file).take(length))).map_err(Into::into)
    }
    fn load(&self, candidate: usize) -> Result<NodeRef> {
        let [offset, length, _, _, _] = self.record(candidate)?;
        let mut file = self.payloads.borrow_mut();
        file.seek(SeekFrom::Start(offset)).map_err(storage)?;
        let snapshot: FlatSnapshot = serde_json::from_reader(BufReader::with_capacity(
            WRITE_BUFFER_BYTES,
            (&mut *file).take(length),
        ))?;
        Ok(snapshot.into_node_ref()?)
    }
    fn is_claimed(&self, candidate: usize) -> Result<bool> {
        Ok(self.record(candidate)?[4] != 0)
    }
    fn claim(&self, candidate: usize) -> Result<()> {
        self.record(candidate)?;
        let offset = u64::try_from(candidate)
            .ok()
            .and_then(|candidate| candidate.checked_mul(INDEX_BYTES))
            .and_then(|offset| offset.checked_add(32))
            .ok_or_else(|| storage(io::Error::other("candidate index overflow")))?;
        let mut file = self.index.borrow_mut();
        file.seek(SeekFrom::Start(offset)).map_err(storage)?;
        file.write_all(&1u64.to_le_bytes()).map_err(storage)
    }
    fn groups(&self) -> Result<Box<dyn Iterator<Item = Result<u64>> + '_>> {
        numbers(&self.directory.path().join("groups"), false)
    }
    fn candidates(
        &self,
        group: CandidateGroup,
    ) -> Result<Box<dyn Iterator<Item = Result<usize>> + '_>> {
        Ok(Box::new(
            numbers(
                &self.bucket_path(group),
                !matches!(group, CandidateGroup::Deletions(_)),
            )?
            .map(|value| {
                value.and_then(|value| {
                    usize::try_from(value).map_err(|error| storage(io::Error::other(error)))
                })
            }),
        ))
    }
    fn named_candidates<'a>(
        &'a self,
        structure_hash: u64,
        label: Option<&'a str>,
    ) -> Result<CandidateIndices<'a, Error>> {
        Ok(Box::new(
            numbers(&self.named_path(structure_hash, label), true)?.map(|value| {
                value.and_then(|value| {
                    usize::try_from(value).map_err(|error| storage(io::Error::other(error)))
                })
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use differens_core::{EditAction, NodeSpec, TreeBuilder};
    use differens_correlate::{
        ActionId, CorrelateOptions, FileChanges, correlate, correlate_store,
    };

    fn node(name: &str, value: &str) -> NodeRef {
        let mut builder = TreeBuilder::new();
        let mut spec = NodeSpec::new("Function");
        spec.label = Some(name.to_owned());
        spec.value = Some(value.to_owned());
        let root = builder.push(spec).unwrap();
        builder.finish(root).unwrap().root_ref()
    }

    fn deletion(node: NodeRef) -> EditAction {
        EditAction::Delete {
            node,
            context: Vec::new(),
        }
    }
    fn insertion(node: NodeRef) -> EditAction {
        EditAction::Insert {
            parent: node.clone(),
            node,
            position: 0,
            context: Vec::new(),
        }
    }

    fn spool(files: &[FileChanges]) -> CandidateSpool {
        let mut spool = CandidateSpool::new().unwrap();
        for (file, changes) in files.iter().enumerate() {
            for (action, value) in changes.actions.iter().enumerate() {
                spool
                    .push_meta(
                        &super::super::candidates::metadata(
                            ActionId { file, action },
                            &changes.file_path,
                            value,
                        ),
                        value.node(),
                    )
                    .unwrap();
            }
        }
        spool
    }

    fn identities(
        moves: &[differens_correlate::CrossFileMatch],
    ) -> Vec<(ActionId, ActionId, bool)> {
        moves
            .iter()
            .map(|movement| (movement.deletion, movement.insertion, movement.modified))
            .collect()
    }

    #[test]
    fn newline_rich_payloads_use_bounded_buffered_writes_and_keep_record_offsets() {
        #[derive(Default)]
        struct CountingWriter {
            bytes: Vec<u8>,
            writes: usize,
        }
        impl Write for CountingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let source = "line é\\value\n".repeat(10_000);
        let candidate = node("large", &source);
        let mut writer = CountingWriter::default();
        write_record(&mut writer, &candidate.snapshot()).unwrap();
        assert!(
            writer.writes < 10,
            "{} underlying writes for {} bytes",
            writer.writes,
            writer.bytes.len()
        );
        let restored: FlatSnapshot = serde_json::from_slice(&writer.bytes).unwrap();
        assert_eq!(
            restored.into_node_ref().unwrap().value.as_deref(),
            Some(source.as_str())
        );
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![deletion(candidate)],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: vec![insertion(node("small", "after large payload"))],
            },
        ];
        let storage = spool(&files);
        assert_eq!(
            storage.load(0).unwrap().value.as_deref(),
            Some(source.as_str())
        );
        assert_eq!(
            storage.load(1).unwrap().value.as_deref(),
            Some("after large payload")
        );
        assert_eq!(storage.metadata(1).unwrap().file, "new.rs");
    }

    #[test]
    fn spilled_correlation_matches_in_memory_order_and_one_to_one_claims() {
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![
                    deletion(node("a", "same body")),
                    deletion(node("b", "return input value alpha")),
                    deletion(node("a", "same body")),
                ],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: vec![
                    insertion(node("a", "same body")),
                    insertion(node("b", "return input value beta")),
                ],
            },
        ];
        let options = CorrelateOptions {
            rename_similarity_threshold: 0.5,
        };
        let memory = correlate(&files, options);
        let storage = spool(&files);
        let disk = correlate_store(&storage, options).unwrap();
        assert_eq!(identities(&disk), identities(&memory));
        assert_eq!(disk.len(), 2);
        assert!(storage.is_claimed(3).unwrap());
        assert!(storage.is_claimed(4).unwrap());
        assert_eq!(storage.load(0).unwrap().value.as_deref(), Some("same body"));
    }

    #[test]
    fn spilled_similarity_preserves_large_bucket_name_filter_and_cap() {
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![deletion(node("target", "return input value alpha"))],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: (0..66)
                    .map(|index| {
                        insertion(node(
                            if index == 40 { "target" } else { "other" },
                            &format!("return input value beta {index}"),
                        ))
                    })
                    .collect(),
            },
        ];
        let options = CorrelateOptions {
            rename_similarity_threshold: 0.4,
        };
        let storage = spool(&files);
        assert_eq!(
            identities(&correlate_store(&storage, options).unwrap()),
            identities(&correlate(&files, options))
        );
        let structure = storage.metadata(0).unwrap().structure_hash;
        let names: Vec<_> = storage
            .named_candidates(structure, Some("target"))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap();
        assert_eq!(names, [41]);
    }

    #[test]
    fn named_disk_index_verifies_hash_collisions_before_similarity_cap() {
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![deletion(node("target", "return input value alpha"))],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: (0..80)
                    .map(|index| {
                        insertion(node(
                            if index == 79 { "target" } else { "other" },
                            "return input value beta",
                        ))
                    })
                    .collect(),
            },
        ];
        let storage = spool(&files);
        let structure = storage.metadata(0).unwrap().structure_hash;
        // Simulate a hash collision placing 79 wrong names before the real match.
        let mut indexes = Vec::new();
        for index in 1u64..=80 {
            indexes.extend_from_slice(&index.to_le_bytes());
        }
        std::fs::write(storage.named_path(structure, Some("target")), indexes).unwrap();
        let moves = correlate_store(&storage, CorrelateOptions::default()).unwrap();
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].insertion.action, 79);
        assert!(moves[0].modified);
    }

    #[test]
    fn exact_bucket_collision_requires_full_content_verification() {
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![deletion(node("before", "alpha"))],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: vec![insertion(node("after", "beta"))],
            },
        ];
        let storage = spool(&files);
        let old = storage.metadata(0).unwrap();
        // Inject a false positive into the exact-hash index, as a collision would.
        storage
            .append_bucket(CandidateGroup::ExactInsertions(old.exact_key), 1)
            .unwrap();
        assert_eq!(
            correlate_store(&storage, CorrelateOptions::default())
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn truncated_payload_or_bucket_aborts_instead_of_hiding_moves() {
        let files = vec![
            FileChanges {
                file_path: "old.rs".into(),
                actions: vec![deletion(node("name", "same"))],
            },
            FileChanges {
                file_path: "new.rs".into(),
                actions: vec![insertion(node("name", "same"))],
            },
        ];
        let storage = spool(&files);
        storage.payloads.borrow_mut().set_len(0).unwrap();
        assert!(correlate_store(&storage, CorrelateOptions::default()).is_err());
        let storage = spool(&files);
        let hash = storage.metadata(0).unwrap().structure_hash;
        OpenOptions::new()
            .write(true)
            .open(storage.bucket_path(CandidateGroup::Deletions(hash)))
            .unwrap()
            .set_len(3)
            .unwrap();
        assert!(correlate_store(&storage, CorrelateOptions::default()).is_err());
    }

    #[test]
    fn drop_cleans_payloads_indexes_and_buckets_after_early_exit() {
        let files = vec![FileChanges {
            file_path: "old.rs".into(),
            actions: vec![deletion(node("name", "payload"))],
        }];
        let storage = spool(&files);
        let directory = storage.directory.path().to_owned();
        assert!(directory.join("payloads").exists());
        drop(storage);
        assert!(!directory.exists());
    }
}
