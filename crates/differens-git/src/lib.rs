//! Byte-preserving file inputs and Git integration for the differens pipeline.
//! Repository operations take an explicit directory and never change process cwd.

mod attributes;
mod files;
mod repository;

pub use attributes::{DRIVER_FLAG, diff_driver_command, generate_git_attributes};
pub use files::{
    DirectoryPairs, diff_directories, diff_directories_stream, is_directory, read_file_pair,
};
pub use repository::{FilePairs, GitRepository, is_git_repo};

use std::{io, path::PathBuf};

/// Presence is independent of content: an empty file still exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilePair {
    pub old_path: String,
    pub new_path: String,
    pub old_source: Vec<u8>,
    pub new_source: Vec<u8>,
    pub old_exists: bool,
    pub new_exists: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not in a Git working tree: {0}")]
    NotRepository(PathBuf),
    #[error("invalid commit range: {0}; expected old..new")]
    InvalidRange(String),
    #[error("invalid Git reference: {0}")]
    InvalidReference(String),
    #[error("Git {command} failed ({status:?}): {message}")]
    Git {
        command: String,
        status: Option<i32>,
        message: String,
    },
    #[error("cannot read file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot write file {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Git process I/O failed: {0}")]
    Process(#[source] io::Error),
    #[error("malformed Git output: {0}")]
    Protocol(String),
    #[error("path cannot be represented as UTF-8: {0:?}")]
    NonUtf8Path(PathBuf),
    #[error("invalid extension: {0:?}")]
    InvalidExtension(String),
}

pub type Result<T> = std::result::Result<T, Error>;

fn path_string(path: &std::path::Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::NonUtf8Path(path.to_owned()))
}

fn git_path(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            Error::NonUtf8Path(std::ffi::OsString::from_vec(bytes.to_vec()).into())
        }
        #[cfg(not(unix))]
        {
            Error::Protocol("Git returned a non-UTF-8 path".into())
        }
    })
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn rejects_non_utf8_git_paths_before_decoding_can_lose_bytes() {
        assert!(matches!(
            super::git_path(b"name-\xff"),
            Err(super::Error::NonUtf8Path(_))
        ));
    }
}
