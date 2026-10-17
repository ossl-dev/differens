use std::{collections::BTreeSet, fs, io, path::PathBuf};

use crate::{Error, GitRepository, Result};

/// Git appends its seven external-diff arguments after this flag.
pub const DRIVER_FLAG: &str = "--git-diff-driver";

#[must_use]
pub fn generate_git_attributes(extensions: &[&str]) -> String {
    extensions
        .iter()
        .map(|extension| format!("*.{extension} diff=differens"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Quote for the POSIX shell Git uses to invoke configured external drivers.
pub fn diff_driver_command(runtime: &str, args: &[&str]) -> String {
    std::iter::once(runtime)
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte))
    {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

impl GitRepository {
    /// Register a local diff command and remove obsolete text converters.
    ///
    /// # Errors
    /// Returns an error when Git cannot read or update repository configuration.
    pub fn install_git_driver(&self, command: &str) -> Result<()> {
        self.run(&["config", "--local", "diff.differens.command", command])?;
        for key in ["diff.differens.textconv", "diff.differens.cachetextconv"] {
            let output = self.output(&["config", "--local", "--unset-all", key])?;
            // Exit 5 means the key was absent; other failures must reach callers.
            if !output.status.success() && output.status.code() != Some(5) {
                return Err(super::repository::command_error("config", &output));
            }
        }
        Ok(())
    }

    /// Preserve unrelated attributes, comments, blank lines, and line endings.
    ///
    /// # Errors
    /// Returns an error for invalid extensions or unreadable/unwritable attributes.
    pub fn write_git_attributes(&self, extensions: &[&str]) -> Result<PathBuf> {
        for extension in extensions {
            if extension.is_empty()
                || !extension
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.+-".contains(&byte))
            {
                return Err(Error::InvalidExtension((*extension).to_owned()));
            }
        }
        let path = self.root().join(".gitattributes");
        let (content, exists) = match fs::read_to_string(&path) {
            Ok(content) => (content, true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (String::new(), false),
            Err(source) => return Err(Error::Read { path, source }),
        };
        let newline = if content.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let requested: BTreeSet<&str> = extensions.iter().copied().collect();
        let mut handled = BTreeSet::new();
        let mut out = String::with_capacity(content.len() + extensions.len() * 24);
        for line in content.split_inclusive('\n') {
            let body = line.trim_end_matches(['\r', '\n']);
            let ending = &line[body.len()..];
            let mut fields = body.split_whitespace();
            let extension = fields.next().and_then(|pattern| pattern.strip_prefix("*."));
            if let Some(extension) = extension.filter(|extension| requested.contains(extension)) {
                handled.insert(extension);
                // Last diff attribute wins, including an existing -diff or another driver.
                if fields.rfind(|attribute| {
                    *attribute == "diff"
                        || *attribute == "-diff"
                        || *attribute == "!diff"
                        || attribute.starts_with("diff=")
                }) != Some("diff=differens")
                {
                    out.push_str(body);
                    out.push_str(" diff=differens");
                    out.push_str(ending);
                    continue;
                }
            }
            out.push_str(line);
        }
        for extension in extensions {
            if handled.insert(extension) {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(newline);
                }
                out.push_str("*.");
                out.push_str(extension);
                out.push_str(" diff=differens");
                out.push_str(newline);
            }
        }
        if out != content || !exists {
            fs::write(&path, out).map_err(|source| Error::Write {
                path: path.clone(),
                source,
            })?;
        }
        Ok(path)
    }
}
