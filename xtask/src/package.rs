use crate::{Result, command};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

pub fn build(root: &Path, dry_run: bool) -> Result<()> {
    command(
        "cargo",
        &["build", "--release", "--locked", "-p", "differens"],
    )?;
    let name = format!("differens{}", std::env::consts::EXE_SUFFIX);
    let binary = root.join("target/release").join(&name);
    let version = env!("CARGO_PKG_VERSION");
    let archive_name = format!(
        "differens-{version}-{}-{}.tar.gz",
        std::env::consts::ARCH,
        std::env::consts::OS
    );
    let out = root.join("target/packages");
    fs::create_dir_all(&out)?;
    if dry_run {
        println!(
            "validated release binary {}; would package {archive_name}",
            binary.display()
        );
        return Ok(());
    }
    let file = fs::File::create(out.join(&archive_name))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    archive.append_path_with_name(&binary, &name)?;
    archive.append_path_with_name(root.join("LICENSE"), "LICENSE")?;
    archive.append_path_with_name(root.join("README.md"), "README.md")?;
    archive.append_path_with_name(
        root.join("THIRD_PARTY_LICENSES.md"),
        "THIRD_PARTY_LICENSES.md",
    )?;
    archive.into_inner()?.finish()?.flush()?;
    let mut file = fs::File::open(out.join(&archive_name))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 65536].into_boxed_slice();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    fs::write(
        out.join(format!("{archive_name}.sha256")),
        format!("{:x}  {archive_name}\n", hasher.finalize()),
    )?;
    println!("created {}", out.join(archive_name).display());
    Ok(())
}
