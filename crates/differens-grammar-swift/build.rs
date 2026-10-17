use std::{
    fs::{self, File},
    path::PathBuf,
};
fn main() {
    println!("cargo:rerun-if-changed=swift.tar.gz");
    let root =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo supplies OUT_DIR")).join("swift");
    {
        if root.exists() {
            fs::remove_dir_all(&root).expect("remove stale extracted Swift grammar");
        }
        let decoder = flate2::read::GzDecoder::new(
            File::open("swift.tar.gz").expect("frozen Swift source archive"),
        );
        tar::Archive::new(decoder)
            .unpack(&root)
            .expect("unpack frozen Swift parser");
    }
    cc::Build::new()
        .include(root.join("src"))
        .include(&root)
        .warnings(false)
        .flag_if_supported("-std=c11")
        .file(root.join("src/parser.c"))
        .file(root.join("src/scanner.c"))
        .compile("differens_swift");
}
