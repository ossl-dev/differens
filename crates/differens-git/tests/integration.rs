use std::{collections::BTreeMap, fs, path::Path, process::Command};

use differens_git::{
    DRIVER_FLAG, Error, GitRepository, diff_directories, diff_directories_stream,
    diff_driver_command, generate_git_attributes, is_directory, is_git_repo, read_file_pair,
};
use tempfile::{TempDir, tempdir};

struct Repo {
    dir: TempDir,
    repo: GitRepository,
}

impl Repo {
    fn new(files: &[(&str, &[u8])]) -> Self {
        let dir = tempdir().unwrap();
        run(dir.path(), &["init", "-q"]);
        run(dir.path(), &["config", "user.name", "Test"]);
        run(dir.path(), &["config", "user.email", "test@example.com"]);
        for (name, bytes) in files {
            write(dir.path(), name, bytes);
        }
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-qm", "init", "--allow-empty"]);
        let repo = GitRepository::discover(dir.path()).unwrap();
        Self { dir, repo }
    }
    fn git(&self, args: &[&str]) -> Vec<u8> {
        run(self.dir.path(), args)
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        write(self.dir.path(), name, bytes);
    }
}

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn run(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[test]
fn detects_worktree_resolves_commits_and_rejects_invalid_refs() {
    let fixture = Repo::new(&[]);
    assert!(is_git_repo(fixture.dir.path()));
    let outside = tempdir().unwrap();
    assert!(!is_git_repo(outside.path()));
    assert!(matches!(
        GitRepository::discover(outside.path()),
        Err(Error::NotRepository(_))
    ));
    assert_eq!(fixture.repo.resolve_ref("HEAD").unwrap().unwrap().len(), 40);
    for reference in ["missing", "--output=/tmp/differens-danger", ""] {
        assert!(fixture.repo.resolve_ref(reference).unwrap().is_none());
    }
    fs::create_dir(fixture.dir.path().join("nested")).unwrap();
    let nested = GitRepository::discover(fixture.dir.path().join("nested")).unwrap();
    assert_eq!(nested.root(), fixture.repo.root());
}

#[test]
fn working_tree_tracks_modified_deleted_untracked_and_empty_files_once() {
    let fixture = Repo::new(&[("a.ts", b"old"), ("gone", b"gone")]);
    assert_eq!(
        fixture.repo.get_changed_files().unwrap(),
        Vec::<String>::new()
    );
    fixture.write("a.ts", b"new");
    fixture.write("new.ts", b"added");
    fixture.write("empty", b"");
    fs::remove_file(fixture.dir.path().join("gone")).unwrap();
    fixture.git(&["add", "new.ts"]);
    let pairs: BTreeMap<_, _> = fixture
        .repo
        .diff_working_tree()
        .unwrap()
        .into_iter()
        .map(|pair| (pair.old_path.clone(), pair))
        .collect();
    assert_eq!(pairs.len(), 4);
    assert_eq!(pairs["a.ts"].old_source, b"old");
    assert_eq!(pairs["a.ts"].new_source, b"new");
    assert!(!pairs["new.ts"].old_exists);
    assert!(pairs["new.ts"].new_exists);
    assert!(!pairs["gone"].new_exists);
    assert!(pairs["empty"].new_exists);
    assert_eq!(pairs["empty"].new_source, b"");
    assert_eq!(
        fixture.repo.get_head_content("a.ts").unwrap(),
        Some(b"old".to_vec())
    );
    assert_eq!(fixture.repo.get_head_content("absent").unwrap(), None);
    assert_eq!(
        fixture.repo.get_working_tree_content("a.ts").unwrap(),
        Some(b"new".to_vec())
    );
    assert_eq!(
        fixture.repo.get_working_tree_content("absent").unwrap(),
        None
    );
}

#[test]
fn supports_unborn_head_staged_and_untracked_paths() {
    let dir = tempdir().unwrap();
    run(dir.path(), &["init", "-q"]);
    write(dir.path(), "staged", b"staged");
    run(dir.path(), &["add", "staged"]);
    write(dir.path(), "untracked", b"untracked");
    let pairs = GitRepository::discover(dir.path())
        .unwrap()
        .diff_working_tree()
        .unwrap();
    assert_eq!(pairs.len(), 2);
    assert!(pairs.iter().all(|pair| !pair.old_exists && pair.new_exists));
}

#[test]
fn preserves_binary_bytes_unicode_and_newlines_in_names() {
    let weird = "☃ space\tline\nbreak.bin";
    let old = b"\xff\0\xf0\x9f\x98\x80\nnot a header\n";
    let new = b"\xfe\0\nnew";
    let fixture = Repo::new(&[(weird, old)]);
    fixture.write(weird, new);
    let pair = fixture.repo.diff_working_tree().unwrap().pop().unwrap();
    assert_eq!(pair.old_path, weird);
    assert_eq!(pair.old_source, old);
    assert_eq!(pair.new_source, new);
    assert_eq!(fixture.repo.get_head_content(weird).unwrap().unwrap(), old);
    fixture.git(&["commit", "-qam", "binary"]);
    let pair = fixture
        .repo
        .diff_commit_range("HEAD~1..HEAD")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(pair.old_source, old);
    assert_eq!(pair.new_source, new);
}

#[test]
fn reads_large_blobs_without_truncation_and_streams_many_pairs() {
    let large = vec![b'x'; 3 * 1024 * 1024];
    let fixture = Repo::new(&[("big", &large)]);
    let mut edited = large.clone();
    edited[2_500_000] = b'y';
    fixture.write("big", &edited);
    for index in 0..80 {
        fixture.write(&format!("file-{index}"), &[index]);
    }
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-qm", "many"]);
    let mut count = 0;
    for pair in fixture
        .repo
        .diff_commit_range_stream("HEAD~1..HEAD")
        .unwrap()
    {
        let pair = pair.unwrap();
        if pair.old_path == "big" {
            assert_eq!(pair.old_source, large);
            assert_eq!(pair.new_source, edited);
        }
        count += 1;
    }
    assert_eq!(count, 81);
    // Early-drop also closes/reaps the persistent Git process.
    assert!(
        fixture
            .repo
            .diff_commit_range_stream("HEAD~1..HEAD")
            .unwrap()
            .next()
            .unwrap()
            .is_ok()
    );
}

#[test]
fn ranges_preserve_renames_additions_deletions_and_presence() {
    let body = b"export function run() { return 1; }\nexport const keep = true;\nexport const unchanged = 'keep this declaration in both snapshots';\n";
    let fixture = Repo::new(&[("old.ts", body), ("gone", b"gone")]);
    fixture.git(&["mv", "old.ts", "new.ts"]);
    fixture.write(
        "new.ts",
        String::from_utf8_lossy(body)
            .replace("return 1", "return 2")
            .as_bytes(),
    );
    fixture.write("empty", b"");
    fixture.git(&["rm", "gone"]);
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-qm", "rename"]);
    let pairs = fixture.repo.diff_commit_range("HEAD~1..HEAD").unwrap();
    assert_eq!(pairs.len(), 3);
    let renamed = pairs.iter().find(|pair| pair.new_path == "new.ts").unwrap();
    assert_eq!(renamed.old_path, "old.ts");
    assert_eq!(renamed.old_source, body);
    assert!(renamed.old_exists && renamed.new_exists);
    let empty = pairs.iter().find(|pair| pair.new_path == "empty").unwrap();
    assert!(!empty.old_exists && empty.new_exists);
    assert_eq!(
        fixture.repo.diff_commit_range("HEAD..HEAD").unwrap(),
        Vec::<differens_git::FilePair>::new()
    );
    for range in ["bad", "HEAD...HEAD", "..HEAD", "HEAD..", "a..b..c"] {
        assert!(matches!(
            fixture.repo.diff_commit_range(range),
            Err(Error::InvalidRange(_))
        ));
    }
    assert!(matches!(
        fixture.repo.diff_commit_range("nope..HEAD"),
        Err(Error::InvalidReference(_))
    ));
}

#[test]
fn directory_inputs_skip_build_trees_preserve_missing_and_read_errors() {
    let old = tempdir().unwrap();
    let new = tempdir().unwrap();
    write(old.path(), "a", b"old");
    write(new.path(), "a", b"new");
    write(old.path(), "sub/gone", b"gone");
    write(new.path(), "sub/empty", b"");
    write(new.path(), "sub/node_modules/pkg/file", b"skip");
    write(new.path(), "target/cache", b"skip");
    let pairs = diff_directories(old.path(), new.path()).unwrap();
    assert_eq!(pairs.len(), 3);
    assert_eq!(pairs[0].old_source, b"old");
    assert_eq!(pairs[0].new_source, b"new");
    assert!(is_directory(old.path()));
    assert!(!is_directory(old.path().join("a")));
    assert!(!is_directory(old.path().join("absent")));
    let pair = read_file_pair(old.path().join("a"), new.path().join("a")).unwrap();
    assert_eq!(pair.old_source, b"old");
    assert!(matches!(
        read_file_pair(old.path().join("missing"), new.path().join("a")),
        Err(Error::Read { .. })
    ));
    let mut stream = diff_directories_stream(old.path(), new.path()).unwrap();
    fs::remove_file(old.path().join("a")).unwrap();
    assert!(matches!(stream.next().unwrap(), Err(Error::Read { .. })));
}

#[test]
fn quotes_driver_arguments_and_preserves_attribute_file_layout() {
    assert_eq!(DRIVER_FLAG, "--git-diff-driver");
    assert_eq!(
        diff_driver_command("/usr/bin/differens", &[DRIVER_FLAG]),
        "/usr/bin/differens --git-diff-driver"
    );
    assert_eq!(
        diff_driver_command("/home/o'brien/differens", &["", "a b"]),
        "'/home/o'\\''brien/differens' '' 'a b'"
    );
    assert_eq!(generate_git_attributes(&[]), "");
    assert_eq!(
        generate_git_attributes(&["ts", "py"]),
        "*.ts diff=differens\n*.py diff=differens"
    );
    let fixture = Repo::new(&[]);
    fixture.write(
        ".gitattributes",
        b"# Preserve this\r\n\r\n*.ts text diff=other\r\n*.md binary\r\n",
    );
    let path = fixture
        .repo
        .write_git_attributes(&["ts", "go", "go"])
        .unwrap();
    let expected = b"# Preserve this\r\n\r\n*.ts text diff=other diff=differens\r\n*.md binary\r\n*.go diff=differens\r\n";
    assert_eq!(fs::read(&path).unwrap(), expected);
    fixture.repo.write_git_attributes(&["ts", "go"]).unwrap();
    assert_eq!(fs::read(path).unwrap(), expected);
    assert!(matches!(
        fixture.repo.write_git_attributes(&["ts\n*.exe"]),
        Err(Error::InvalidExtension(_))
    ));
    fixture.git(&["config", "diff.differens.textconv", "old"]);
    fixture.git(&["config", "diff.differens.cachetextconv", "true"]);
    fixture
        .repo
        .install_git_driver("differens --git-diff-driver")
        .unwrap();
    fixture
        .repo
        .install_git_driver("differens --git-diff-driver")
        .unwrap();
    let config = String::from_utf8(fixture.git(&["config", "--local", "--list"])).unwrap();
    assert!(config.contains("diff.differens.command=differens --git-diff-driver"));
    assert!(!config.contains("textconv"));
}

#[cfg(unix)]
#[test]
fn reads_symlink_targets_without_following_them() {
    use std::os::unix::fs::symlink;
    let fixture = Repo::new(&[]);
    symlink("absent-target", fixture.dir.path().join("link")).unwrap();
    fixture.git(&["add", "link"]);
    fixture.git(&["commit", "-qm", "symlink"]);
    fs::remove_file(fixture.dir.path().join("link")).unwrap();
    symlink("new-absent-target", fixture.dir.path().join("link")).unwrap();
    let pair = fixture.repo.diff_working_tree().unwrap().pop().unwrap();
    assert_eq!(pair.old_source, b"absent-target");
    assert_eq!(pair.new_source, b"new-absent-target");
}

#[cfg(unix)]
#[test]
fn standalone_file_pairs_follow_links_and_compare_their_file_contents() {
    use std::os::unix::fs::symlink;
    let old = tempdir().unwrap();
    let new = tempdir().unwrap();
    fs::write(old.path().join("target.ts"), b"const x = 1;").unwrap();
    fs::write(new.path().join("target.ts"), b"const x = 2;").unwrap();
    symlink("target.ts", old.path().join("link.ts")).unwrap();
    symlink("target.ts", new.path().join("link.ts")).unwrap();
    let pair = read_file_pair(old.path().join("link.ts"), new.path().join("link.ts")).unwrap();
    assert_eq!(pair.old_source, b"const x = 1;");
    assert_eq!(pair.new_source, b"const x = 2;");
    let pairs = diff_directories(old.path(), new.path()).unwrap();
    let links = pairs
        .iter()
        .find(|pair| pair.old_path == "link.ts")
        .unwrap();
    assert_eq!(links.old_source, b"target.ts");
    assert_eq!(links.new_source, b"target.ts");
    fs::remove_file(new.path().join("target.ts")).unwrap();
    assert!(matches!(
        read_file_pair(old.path().join("link.ts"), new.path().join("link.ts")),
        Err(Error::Read { .. })
    ));
}

#[test]
fn driver_attributes_accept_compound_literal_extensions_and_reject_glob_injection() {
    let fixture = Repo::new(&[]);
    fixture.repo.write_git_attributes(&["d.ts", "c++"]).unwrap();
    let attributes = fixture.git(&["check-attr", "diff", "--", "file.d.ts", "file.c++"]);
    assert!(
        String::from_utf8(attributes)
            .unwrap()
            .lines()
            .all(|line| line.ends_with(": differens"))
    );
    let path = fixture.dir.path().join(".gitattributes");
    let first = fs::read(&path).unwrap();
    fixture.repo.write_git_attributes(&["d.ts", "c++"]).unwrap();
    assert_eq!(fs::read(path).unwrap(), first);
    for extension in [
        "*",
        "?",
        "[a]",
        "a/b",
        "a\\b",
        "a b",
        "a\tb",
        "a\nb",
        "a\0b",
        "ts diff=other",
    ] {
        assert!(
            matches!(
                fixture.repo.write_git_attributes(&[extension]),
                Err(Error::InvalidExtension(_))
            ),
            "{extension:?}"
        );
    }
}

#[test]
fn working_tree_keeps_tracked_changes_before_untracked_paths() {
    let fixture = Repo::new(&[("z.ts", b"const z=1;")]);
    fixture.write("z.ts", b"const z=2;");
    fixture.write("a.ts", b"const a=1;");
    assert_eq!(fixture.repo.get_changed_files().unwrap(), ["z.ts", "a.ts"]);
    let paths: Vec<_> = fixture
        .repo
        .diff_working_tree_stream()
        .unwrap()
        .map(|pair| pair.unwrap().new_path)
        .collect();
    assert_eq!(paths, ["z.ts", "a.ts"]);
}

#[test]
fn preserves_submodule_commit_identity_in_working_and_committed_snapshots() {
    let fixture = Repo::new(&[]);
    let module = fixture.dir.path().join("module");
    fs::create_dir(&module).unwrap();
    run(&module, &["init", "-q"]);
    run(&module, &["config", "user.name", "Test"]);
    run(&module, &["config", "user.email", "test@example.com"]);
    write(&module, "file", b"one");
    run(&module, &["add", "."]);
    run(&module, &["commit", "-qm", "first"]);
    let old = String::from_utf8(run(&module, &["rev-parse", "HEAD"])).unwrap();
    fixture.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{},module", old.trim()),
    ]);
    fixture.git(&["commit", "-qm", "module"]);
    write(&module, "file", b"two");
    run(&module, &["commit", "-qam", "second"]);
    let new = String::from_utf8(run(&module, &["rev-parse", "HEAD"])).unwrap();
    let pair = fixture
        .repo
        .diff_working_tree()
        .unwrap()
        .into_iter()
        .find(|pair| pair.old_path == "module")
        .unwrap();
    assert_eq!(
        pair.old_source,
        format!("Subproject commit {}\n", old.trim()).as_bytes()
    );
    assert_eq!(
        pair.new_source,
        format!("Subproject commit {}\n", new.trim()).as_bytes()
    );
    assert_eq!(
        fixture.repo.get_head_content("module").unwrap(),
        Some(pair.old_source.clone())
    );
    fixture.git(&["add", "module"]);
    fixture.git(&["commit", "-qm", "update module"]);
    let committed = fixture
        .repo
        .diff_commit_range("HEAD~1..HEAD")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(committed.old_source, pair.old_source);
    assert_eq!(committed.new_source, pair.new_source);
}

#[test]
fn failed_repository_and_file_reads_are_not_reported_as_empty_contents() {
    let fixture = Repo::new(&[("nested/a", b"data")]);
    assert!(fixture.repo.get_head_content("nested").is_err());
    assert!(fixture.repo.get_working_tree_content("nested").is_err());
    assert_eq!(fixture.repo.changed_files().unwrap(), Vec::<String>::new());
    assert!(fixture.repo.resolve_ref("bad\0ref").unwrap().is_none());
    fixture.write("untracked", b"data");
    let mut stream = fixture.repo.diff_working_tree_stream().unwrap();
    fs::remove_file(fixture.dir.path().join("untracked")).unwrap();
    let gone = stream.next().unwrap().unwrap();
    assert!(!gone.old_exists && !gone.new_exists);
    assert!(stream.next().is_none());
    fs::remove_dir_all(fixture.dir.path().join(".git")).unwrap();
    assert!(matches!(
        fixture.repo.diff_working_tree(),
        Err(Error::Git { .. })
    ));
}

#[test]
fn empty_attributes_are_created_and_missing_new_files_or_roots_fail_clearly() {
    let fixture = Repo::new(&[("a", b"old")]);
    let path = fixture.repo.write_git_attributes(&[]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"");
    fs::write(&path, b"*.ts text\n\n# comment without newline").unwrap();
    fixture.repo.write_git_attributes(&["ts"]).unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        b"*.ts text diff=differens\n\n# comment without newline"
    );
    assert!(matches!(
        fixture.repo.write_git_attributes(&[""]),
        Err(Error::InvalidExtension(_))
    ));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        fixture.repo.write_git_attributes(&["ts"]),
        Err(Error::Read { .. })
    ));
    assert!(matches!(
        read_file_pair(
            fixture.dir.path().join("a"),
            fixture.dir.path().join("absent")
        ),
        Err(Error::Read { .. })
    ));
    assert!(diff_directories(fixture.dir.path().join("a"), fixture.dir.path()).is_err());
    let other = tempdir().unwrap();
    let stream = diff_directories_stream(other.path(), other.path()).unwrap();
    assert_eq!(stream.len(), 0);
    assert_eq!(stream.size_hint(), (0, Some(0)));
}

// macOS filesystems reject malformed UTF-8 when creating a directory entry.
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn rejects_non_utf8_paths_without_loss() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let fixture = Repo::new(&[]);
    fs::write(
        fixture
            .dir
            .path()
            .join(OsString::from_vec(b"invalid-\xff".to_vec())),
        b"data",
    )
    .unwrap();
    assert!(matches!(
        fixture.repo.diff_working_tree(),
        Err(Error::NonUtf8Path(_))
    ));
    let other = tempdir().unwrap();
    assert!(matches!(
        diff_directories(fixture.dir.path(), other.path()),
        Err(Error::NonUtf8Path(_))
    ));
}
