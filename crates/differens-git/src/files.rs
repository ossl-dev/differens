use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

use walkdir::WalkDir;

use crate::{Error, FilePair, Result, path_string};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".turbo",
    ".cache",
    "vendor",
    "__pycache__",
    ".venv",
];

pub fn is_directory(path: impl AsRef<Path>) -> bool {
    path.as_ref().is_dir()
}

/// Read both required files without decoding their bytes.
///
/// # Errors
/// Returns an error for non-UTF-8 paths or any file read failure, including absence.
pub fn read_file_pair(old_path: impl AsRef<Path>, new_path: impl AsRef<Path>) -> Result<FilePair> {
    let old_path = old_path.as_ref();
    let new_path = new_path.as_ref();
    Ok(FilePair {
        old_path: path_string(old_path)?,
        new_path: path_string(new_path)?,
        old_source: read_contents(old_path)?,
        new_source: read_contents(new_path)?,
        old_exists: true,
        new_exists: true,
    })
}

pub(crate) fn read_required(path: &Path) -> Result<Vec<u8>> {
    // Git stores symlink targets, not the contents of the linked file.
    let metadata = fs::symlink_metadata(path).map_err(|source| Error::Read {
        path: path.to_owned(),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(path).map_err(|source| Error::Read {
            path: path.to_owned(),
            source,
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            return Ok(target.as_os_str().as_bytes().to_vec());
        }
        #[cfg(not(unix))]
        {
            return Ok(path_string(&target)?.into_bytes());
        }
    }
    read_contents(path)
}

fn read_contents(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|source| Error::Read {
        path: path.to_owned(),
        source,
    })
}

pub(crate) fn read_optional(path: &Path) -> Result<(Vec<u8>, bool)> {
    match read_required(path) {
        Ok(source) => Ok((source, true)),
        Err(Error::Read { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            Ok((Vec::new(), false))
        }
        Err(error) => Err(error),
    }
}

fn list_files(root: &Path) -> Result<BTreeSet<String>> {
    if !root.is_dir() {
        return Err(Error::Read {
            path: root.to_owned(),
            source: io::Error::new(io::ErrorKind::NotADirectory, "expected a directory"),
        });
    }
    let mut paths = BTreeSet::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || !SKIP_DIRS.iter().any(|name| entry.file_name() == *name)
        })
    {
        let entry = entry.map_err(|error| Error::Read {
            path: error.path().unwrap_or(root).to_owned(),
            source: io::Error::other(error),
        })?;
        if entry.file_type().is_file() || entry.file_type().is_symlink() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| Error::Protocol("directory entry escaped its root".into()))?;
            paths.insert(path_string(relative)?);
        }
    }
    Ok(paths)
}

/// Retains path metadata but reads only the current pair's bytes.
pub struct DirectoryPairs {
    old_root: PathBuf,
    new_root: PathBuf,
    paths: std::collections::btree_set::IntoIter<String>,
    old_paths: BTreeSet<String>,
    new_paths: BTreeSet<String>,
}

impl Iterator for DirectoryPairs {
    type Item = Result<FilePair>;
    fn next(&mut self) -> Option<Self::Item> {
        let path = self.paths.next()?;
        Some((|| {
            let old_exists = self.old_paths.contains(&path);
            let new_exists = self.new_paths.contains(&path);
            Ok(FilePair {
                old_source: if old_exists {
                    read_required(&self.old_root.join(&path))?
                } else {
                    Vec::new()
                },
                new_source: if new_exists {
                    read_required(&self.new_root.join(&path))?
                } else {
                    Vec::new()
                },
                old_path: path.clone(),
                new_path: path,
                old_exists,
                new_exists,
            })
        })())
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.paths.size_hint()
    }
}

impl ExactSizeIterator for DirectoryPairs {}

/// Enumerate directory paths and load contents only as the iterator advances.
///
/// # Errors
/// Returns an error when either tree cannot be walked or a path is non-UTF-8.
/// File read failures are yielded by the returned iterator.
pub fn diff_directories_stream(
    old_root: impl AsRef<Path>,
    new_root: impl AsRef<Path>,
) -> Result<DirectoryPairs> {
    let old_root = old_root.as_ref();
    let new_root = new_root.as_ref();
    let old_paths = list_files(old_root)?;
    let new_paths = list_files(new_root)?;
    let paths = old_paths
        .union(&new_paths)
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter();
    Ok(DirectoryPairs {
        old_root: old_root.to_owned(),
        new_root: new_root.to_owned(),
        paths,
        old_paths,
        new_paths,
    })
}

/// Collect byte-preserving file pairs from two directory trees.
///
/// # Errors
/// Returns an error for directory traversal, non-UTF-8 paths, or failed file reads.
pub fn diff_directories(
    old_root: impl AsRef<Path>,
    new_root: impl AsRef<Path>,
) -> Result<Vec<FilePair>> {
    diff_directories_stream(old_root, new_root)?.collect()
}
