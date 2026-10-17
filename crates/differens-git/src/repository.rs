use std::{
    collections::{HashSet, VecDeque},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Output, Stdio},
};

use crate::{Error, FilePair, Result, files::read_optional, git_path};

#[derive(Clone, Debug)]
pub struct GitRepository {
    root: PathBuf,
}

pub fn is_git_repo(cwd: impl AsRef<Path>) -> bool {
    GitRepository::discover(cwd).is_ok()
}

impl GitRepository {
    /// Find the working-tree root from any directory inside a repository.
    ///
    /// # Errors
    /// Returns an error outside a working tree, for non-UTF-8 roots, or when Git
    /// cannot be executed.
    pub fn discover(cwd: impl AsRef<Path>) -> Result<Self> {
        let cwd = cwd.as_ref();
        let output = Command::new("git")
            .current_dir(cwd)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .map_err(Error::Process)?;
        if !output.status.success() {
            return Err(Error::NotRepository(cwd.to_owned()));
        }
        let bytes = output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout);
        Ok(Self {
            root: PathBuf::from(git_path(bytes)?),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn output(&self, args: &[&str]) -> Result<Output> {
        Command::new("git")
            .current_dir(&self.root)
            .args(args)
            .output()
            .map_err(Error::Process)
    }

    pub(crate) fn run(&self, args: &[&str]) -> Result<Vec<u8>> {
        let output = self.output(args)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(command_error(args.first().copied().unwrap_or(""), &output))
        }
    }

    /// Resolves commits only; option-like references cannot become Git flags.
    ///
    /// # Errors
    /// Returns an error when Git cannot execute or produces malformed output.
    /// Unresolvable references return `Ok(None)`.
    pub fn resolve_ref(&self, reference: &str) -> Result<Option<String>> {
        if reference.is_empty() || reference.starts_with('-') || reference.contains('\0') {
            return Ok(None);
        }
        let commit = format!("{reference}^{{commit}}");
        let output = self.output(&["rev-parse", "--verify", "--end-of-options", &commit])?;
        if !output.status.success() {
            return Ok(None);
        }
        let hash = String::from_utf8(output.stdout)
            .map_err(|_| Error::Protocol("non-ASCII commit ID".into()))?;
        Ok(Some(hash.trim().to_owned()))
    }

    /// List modified, added, deleted, and untracked paths relative to the root.
    ///
    /// # Errors
    /// Returns an error for Git failures, malformed output, or non-UTF-8 paths.
    pub fn get_changed_files(&self) -> Result<Vec<String>> {
        Ok(self
            .working_tree_changes()?
            .into_iter()
            .map(|change| change.new_path)
            .collect())
    }

    /// Alias for [`Self::get_changed_files`].
    ///
    /// # Errors
    /// Returns the same Git and path errors as [`Self::get_changed_files`].
    pub fn changed_files(&self) -> Result<Vec<String>> {
        self.get_changed_files()
    }

    /// Read a repository-relative blob at HEAD; absence returns `None`.
    ///
    /// # Errors
    /// Returns an error for Git failures, malformed output, or a non-file entry.
    pub fn get_head_content(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let Some(head) = self.resolve_ref("HEAD")? else {
            return Ok(None);
        };
        // ls-tree has NUL-framed paths and literal pathspecs, so newline-containing
        // names are never inserted into cat-file's line-delimited request stream.
        let literal_path = format!(":(literal){path}");
        let output = self.run(&["ls-tree", "-z", "--full-tree", &head, "--", &literal_path])?;
        let Some(record) = output
            .split(|byte| *byte == 0)
            .find(|record| !record.is_empty())
        else {
            return Ok(None);
        };
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| Error::Protocol("ls-tree record has no path".into()))?;
        let fields: Vec<_> = record[..tab].split(|byte| *byte == b' ').collect();
        if fields.len() != 3 {
            return Err(Error::Protocol("invalid ls-tree record".into()));
        }
        if fields[1] == b"commit" {
            return Ok(Some(submodule_content(&git_path(fields[2])?)));
        }
        if fields[1] != b"blob" {
            return Err(Error::Protocol(format!("path is not a blob: {path}")));
        }
        Ok(Some(
            BatchReader::new(&self.root)?.read_blob(&git_path(fields[2])?)?,
        ))
    }

    /// Read a working-tree file; absence returns `None`.
    ///
    /// # Errors
    /// Returns an error for read failures other than a missing file.
    pub fn get_working_tree_content(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let (bytes, exists) = read_optional(&self.root.join(path))?;
        Ok(exists.then_some(bytes))
    }

    fn working_tree_changes(&self) -> Result<Vec<PathChange>> {
        let head = self.resolve_ref("HEAD")?;
        let mut changes = if let Some(head) = &head {
            let raw = self.run(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--raw",
                "-z",
                "--no-abbrev",
                "--no-renames",
                "--ignore-submodules=none",
                head,
                "--",
            ])?;
            parse_raw(&raw, true)?
        } else {
            let raw = self.run(&[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--raw",
                "-z",
                "--no-abbrev",
                "--no-renames",
                "--",
            ])?;
            parse_raw(&raw, true)?
        };
        let mut seen: HashSet<_> = changes
            .iter()
            .map(|change| change.new_path.clone())
            .collect();
        let args = ["ls-files", "--others", "--exclude-standard", "-z"];
        for path in self
            .run(&args)?
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = git_path(path)?;
            if seen.insert(path.clone()) {
                changes.push(PathChange {
                    old_path: path.clone(),
                    new_path: path.clone(),
                    old: Source::Missing,
                    new: Source::Disk(path, None),
                });
            }
        }
        Ok(changes)
    }

    /// Compare HEAD to disk, including staged and untracked changes.
    ///
    /// # Errors
    /// Returns an error for Git failures or malformed/non-UTF-8 paths. The
    /// iterator yields subsequent blob or working-tree read failures.
    pub fn diff_working_tree_stream(&self) -> Result<FilePairs> {
        Ok(FilePairs::new(
            self.root.clone(),
            self.working_tree_changes()?,
        ))
    }

    /// Collect HEAD-to-working-tree file pairs.
    ///
    /// # Errors
    /// Returns an error for Git failures, unsupported paths, or failed file reads.
    pub fn diff_working_tree(&self) -> Result<Vec<FilePair>> {
        self.diff_working_tree_stream()?.collect()
    }

    /// Compare an explicit `old..new` commit range, preserving rename paths.
    ///
    /// # Errors
    /// Returns an error for malformed ranges, invalid commits, Git failures, or
    /// non-UTF-8 paths. The iterator yields subsequent blob read failures.
    pub fn diff_commit_range_stream(&self, range: &str) -> Result<FilePairs> {
        let (old, new) = range
            .split_once("..")
            .filter(|(old, new)| {
                !old.is_empty() && !new.is_empty() && !new.contains("..") && !new.starts_with('.')
            })
            .ok_or_else(|| Error::InvalidRange(range.to_owned()))?;
        let old = self
            .resolve_ref(old)?
            .ok_or_else(|| Error::InvalidReference(old.to_owned()))?;
        let new = self
            .resolve_ref(new)?
            .ok_or_else(|| Error::InvalidReference(new.to_owned()))?;
        self.diff_commit_ids_stream(&old, &new)
    }

    /// Compare two already resolved commit IDs without spawning ref lookups.
    /// Git verifies both IDs refer to commits within the diff operation.
    ///
    /// # Errors
    /// Rejects non-hex IDs, non-commit objects, Git failures, and unsupported paths.
    pub fn diff_commit_ids_stream(&self, old: &str, new: &str) -> Result<FilePairs> {
        for id in [old, new] {
            if !matches!(id.len(), 40 | 64) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(Error::InvalidReference(id.to_owned()));
            }
        }
        let old = format!("{old}^{{commit}}");
        let new = format!("{new}^{{commit}}");
        let raw = self.run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--raw",
            "-z",
            "--no-abbrev",
            "--find-renames",
            &old,
            &new,
            "--",
        ])?;
        Ok(FilePairs::new(self.root.clone(), parse_raw(&raw, false)?))
    }

    /// Collect file pairs for an `old..new` commit range.
    ///
    /// # Errors
    /// Returns an error for malformed ranges, invalid commits, Git failures,
    /// unsupported paths, or failed blob reads.
    pub fn diff_commit_range(&self, range: &str) -> Result<Vec<FilePair>> {
        self.diff_commit_range_stream(range)?.collect()
    }
}

pub(crate) fn command_error(command: &str, output: &Output) -> Error {
    Error::Git {
        command: command.to_owned(),
        status: output.status.code(),
        message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    }
}

#[derive(Debug)]
enum Source {
    Missing,
    Blob(String),
    Submodule(String),
    Disk(String, Option<String>),
}

#[derive(Debug)]
struct PathChange {
    old_path: String,
    new_path: String,
    old: Source,
    new: Source,
}

fn object_source(mode: &[u8], id: &[u8]) -> Result<Source> {
    if mode == b"000000" {
        return Ok(Source::Missing);
    }
    let id = git_path(id)?;
    if !matches!(id.len(), 40 | 64) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::Protocol("invalid object ID".into()));
    }
    Ok(if mode == b"160000" {
        Source::Submodule(id)
    } else {
        Source::Blob(id)
    })
}

fn parse_raw(raw: &[u8], working: bool) -> Result<Vec<PathChange>> {
    let mut fields = raw.split(|byte| *byte == 0);
    let mut changes = Vec::new();
    while let Some(header) = fields.next().filter(|header| !header.is_empty()) {
        let metadata: Vec<_> = header
            .strip_prefix(b":")
            .ok_or_else(|| Error::Protocol("raw diff record has no colon".into()))?
            .split(|byte| *byte == b' ')
            .collect();
        if metadata.len() != 5 {
            return Err(Error::Protocol("invalid raw diff metadata".into()));
        }
        let old_path = git_path(
            fields
                .next()
                .ok_or_else(|| Error::Protocol("missing diff path".into()))?,
        )?;
        let renamed = metadata[4].starts_with(b"R") || metadata[4].starts_with(b"C");
        let new_path = if renamed {
            git_path(
                fields
                    .next()
                    .ok_or_else(|| Error::Protocol("missing rename destination".into()))?,
            )?
        } else {
            old_path.clone()
        };
        let old = object_source(metadata[0], metadata[2])?;
        let new = if working && metadata[1] != b"000000" {
            let gitlink = if metadata[1] == b"160000" {
                Some(git_path(metadata[3])?)
            } else {
                None
            };
            Source::Disk(new_path.clone(), gitlink)
        } else {
            object_source(metadata[1], metadata[3])?
        };
        changes.push(PathChange {
            old_path,
            new_path,
            old,
            new,
        });
    }
    Ok(changes)
}

/// Loads one pair at a time through one persistent Git process. Dropping the
/// iterator early closes and reaps that process; blob memory stays bounded by
/// the current file rather than the complete changeset.
pub struct FilePairs {
    root: PathBuf,
    paths: std::vec::IntoIter<PathChange>,
    reader: Option<BatchReader>,
    failed: bool,
}

impl FilePairs {
    fn new(root: PathBuf, paths: Vec<PathChange>) -> Self {
        Self {
            root,
            paths: paths.into_iter(),
            reader: None,
            failed: false,
        }
    }

    fn read(&mut self, source: &Source) -> Result<(Vec<u8>, bool)> {
        match source {
            Source::Missing => Ok((Vec::new(), false)),
            Source::Submodule(id) => Ok((submodule_content(id), true)),
            Source::Disk(path, None) => read_optional(&self.root.join(path)),
            Source::Disk(path, Some(commit)) => read_submodule(&self.root.join(path), commit),
            Source::Blob(id) => {
                if self.reader.is_none() {
                    self.reader = Some(BatchReader::new(&self.root)?);
                }
                let reader = self
                    .reader
                    .as_mut()
                    .ok_or_else(|| Error::Protocol("missing blob reader".into()))?;
                Ok((reader.read_blob(id)?, true))
            }
        }
    }

    fn prepare_blobs(&mut self, current: &PathChange) -> Result<()> {
        if !matches!(current.old, Source::Blob(_)) && !matches!(current.new, Source::Blob(_)) {
            return Ok(());
        }
        let ids: Vec<_> = std::iter::once(current)
            .chain(self.paths.as_slice())
            .flat_map(|change| [&change.old, &change.new])
            .filter_map(|source| match source {
                Source::Blob(id) => Some(id.as_str()),
                _ => None,
            })
            .take(BLOB_LOOKAHEAD)
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        if self.reader.is_none() {
            self.reader = Some(BatchReader::new(&self.root)?);
        }
        if let Some(reader) = &mut self.reader {
            reader.queue(&ids)?;
        }
        Ok(())
    }
}

impl Iterator for FilePairs {
    type Item = Result<FilePair>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        let change = self.paths.next()?;
        let result = (|| {
            self.prepare_blobs(&change)?;
            let (old_source, old_exists) = self.read(&change.old)?;
            let (new_source, new_exists) = self.read(&change.new)?;
            Ok(FilePair {
                old_path: change.old_path,
                new_path: change.new_path,
                old_source,
                new_source,
                old_exists,
                new_exists,
            })
        })();
        self.failed = result.is_err();
        Some(result)
    }
}

fn read_submodule(root: &Path, index_commit: &str) -> Result<(Vec<u8>, bool)> {
    if !root.try_exists().map_err(|source| Error::Read {
        path: root.to_owned(),
        source,
    })? {
        return Ok((Vec::new(), false));
    }
    match std::fs::symlink_metadata(root.join(".git")) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((submodule_content(index_commit), true));
        }
        Err(source) => {
            return Err(Error::Read {
                path: root.join(".git"),
                source,
            });
        }
    }
    let output = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .map_err(Error::Process)?;
    if !output.status.success() {
        return Err(command_error("rev-parse", &output));
    }
    let id = String::from_utf8(output.stdout)
        .map_err(|_| Error::Protocol("invalid submodule commit".into()))?;
    let status = Command::new("git")
        .current_dir(root)
        .args([
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ])
        .output()
        .map_err(Error::Process)?;
    if !status.status.success() {
        return Err(command_error("status", &status));
    }
    let id = if status.stdout.is_empty() {
        id.trim().to_owned()
    } else {
        format!("{}-dirty", id.trim())
    };
    Ok((submodule_content(&id), true))
}

fn submodule_content(id: &str) -> Vec<u8> {
    format!("Subproject commit {id}\n").into_bytes()
}

struct BatchReader {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    pending: VecDeque<String>,
}

// Six SHA-256 requests occupy at most 390 bytes, below POSIX's minimum pipe
// capacity. This lookahead overlaps Git's work without buffering blob bodies or
// blocking while a large response fills the opposite pipe.
const BLOB_LOOKAHEAD: usize = 6;

impl BatchReader {
    fn new(root: &Path) -> Result<Self> {
        let mut child = Command::new("git")
            .current_dir(root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(Error::Process)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| Error::Protocol("missing Git stdin".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Error::Protocol("missing Git stdout".into()))?;
        Ok(Self {
            child,
            input: Some(input),
            output: BufReader::new(output),
            pending: VecDeque::new(),
        })
    }

    fn queue(&mut self, ids: &[&str]) -> Result<()> {
        if self.pending.len() > ids.len()
            || !self
                .pending
                .iter()
                .zip(ids)
                .all(|(pending, id)| pending == id)
        {
            return Err(Error::Protocol("blob request order changed".into()));
        }
        let new = &ids[self.pending.len()..];
        if new.is_empty() {
            return Ok(());
        }
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| Error::Protocol("closed Git input".into()))?;
        let mut request = String::with_capacity(new.len() * 65);
        for id in new {
            request.push_str(id);
            request.push('\n');
        }
        input
            .write_all(request.as_bytes())
            .map_err(Error::Process)?;
        input.flush().map_err(Error::Process)?;
        self.pending.extend(new.iter().map(|id| (*id).to_owned()));
        Ok(())
    }

    fn read_blob(&mut self, id: &str) -> Result<Vec<u8>> {
        if self.pending.is_empty() {
            self.queue(&[id])?;
        }
        if self.pending.front().map(String::as_str) != Some(id) {
            return Err(Error::Protocol("unexpected blob request".into()));
        }
        let bytes = read_blob_record(&mut self.output, id)?;
        self.pending.pop_front();
        Ok(bytes)
    }
}

fn read_blob_record(output: &mut impl BufRead, id: &str) -> Result<Vec<u8>> {
    let mut header = String::new();
    output.read_line(&mut header).map_err(Error::Process)?;
    let fields: Vec<_> = header.split_whitespace().collect();
    if fields.len() != 3 || fields[0] != id || fields[1] != "blob" {
        return Err(Error::Protocol(format!(
            "unexpected cat-file header: {header:?}"
        )));
    }
    let size: usize = fields[2]
        .parse()
        .map_err(|_| Error::Protocol("invalid blob size".into()))?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(size).map_err(|error| {
        Error::Protocol(format!("cannot allocate blob of {size} bytes: {error}"))
    })?;
    bytes.resize(size, 0);
    output.read_exact(&mut bytes).map_err(Error::Process)?;
    let mut terminator = [0];
    output.read_exact(&mut terminator).map_err(Error::Process)?;
    if terminator != *b"\n" {
        return Err(Error::Protocol("missing blob terminator".into()));
    }
    Ok(bytes)
}

impl Drop for BatchReader {
    fn drop(&mut self) {
        self.input.take();
        // Never leave a child waiting for its pipe if a caller stops early.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_framing_is_byte_exact_and_rejects_truncation_or_malformed_records() {
        let mut input = std::io::Cursor::new(b"abc blob 4\n\xff\0\nX\nabc blob 0\n\n");
        assert_eq!(read_blob_record(&mut input, "abc").unwrap(), b"\xff\0\nX");
        assert_eq!(read_blob_record(&mut input, "abc").unwrap(), b"");
        for record in [
            b"abc missing\n".as_slice(),
            b"other blob 1\nx\n",
            b"abc tree 1\nx\n",
            b"abc blob invalid\n",
            b"abc blob 2\nx",
            b"abc blob 1\nx",
            b"abc blob 1\nxX",
            b"\xff blob 0\n\n",
        ] {
            assert!(
                read_blob_record(&mut std::io::Cursor::new(record), "abc").is_err(),
                "{record:?}"
            );
        }
        let oversized = format!("abc blob {}\n", usize::MAX);
        assert!(read_blob_record(&mut std::io::Cursor::new(oversized), "abc").is_err());
    }

    #[test]
    fn raw_diff_protocol_rejects_bad_headers_paths_and_object_ids() {
        for bytes in [b"bad\0".as_slice(), b":100644\0a\0", b":100644 100644 x y M\0a\0", b":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100"] {
            assert!(parse_raw(bytes, false).is_err(), "{bytes:?}");
        }
        assert!(object_source(b"100644", b"not-an-oid").is_err());
        assert!(object_source(b"100644", b"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        let raw = b":100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 C100\0old name\0new\nname\0";
        let changes = parse_raw(raw, false).unwrap();
        assert_eq!(changes[0].old_path, "old name");
        assert_eq!(changes[0].new_path, "new\nname");
        assert!(matches!(changes[0].new, Source::Blob(_)));
    }

    #[test]
    fn invalid_blob_requests_and_closed_processes_fail_without_phantom_content() {
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new("git")
            .current_dir(directory.path())
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let mut reader = BatchReader::new(directory.path()).unwrap();
        assert!(matches!(
            reader.read_blob("missing-object"),
            Err(Error::Protocol(_))
        ));
        reader.input.take();
        assert!(matches!(
            reader.read_blob("missing-object"),
            Err(Error::Protocol(_))
        ));
        let mut reader = BatchReader::new(directory.path()).unwrap();
        reader.child.kill().unwrap();
        reader.child.wait().unwrap();
        assert!(reader.read_blob("missing-object").is_err());
    }

    #[test]
    fn lazy_pair_error_is_emitted_once_then_iteration_stops() {
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new("git")
            .current_dir(directory.path())
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let mut stream = FilePairs::new(
            directory.path().to_owned(),
            vec![PathChange {
                old_path: "a".into(),
                new_path: "a".into(),
                old: Source::Blob("missing-object".into()),
                new: Source::Missing,
            }],
        );
        assert!(stream.next().unwrap().is_err());
        assert!(stream.next().is_none());
        let mut stream = FilePairs::new(
            directory.path().to_owned(),
            vec![PathChange {
                old_path: "module".into(),
                new_path: "module".into(),
                old: Source::Missing,
                new: Source::Disk("module".into(), Some("index-commit".into())),
            }],
        );
        assert!(!stream.next().unwrap().unwrap().new_exists);
        std::fs::create_dir(directory.path().join("module")).unwrap();
        std::fs::write(
            directory.path().join("module/.git"),
            "invalid git directory",
        )
        .unwrap();
        let mut stream = FilePairs::new(
            directory.path().to_owned(),
            vec![PathChange {
                old_path: "module".into(),
                new_path: "module".into(),
                old: Source::Missing,
                new: Source::Disk("module".into(), Some("index-commit".into())),
            }],
        );
        assert!(stream.next().unwrap().is_err());
    }
}
