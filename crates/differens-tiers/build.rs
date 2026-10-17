use std::{
    collections::HashSet,
    fs::{self, File},
    path::{Path, PathBuf},
};

fn main() {
    if std::env::var_os("CARGO_FEATURE_CODE").is_none() {
        return;
    }
    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo supplies OUT_DIR"));
    let grammars = [
        ("javascript", "src"),
        ("typescript", "typescript/src"),
        ("typescript", "tsx/src"),
        ("python", "src"),
        ("rust", "src"),
        ("go", "src"),
        ("c", "src"),
        ("cpp", "src"),
        ("java", "src"),
        ("ruby", "src"),
        ("php", "php/src"),
        ("kotlin", "src"),
        ("c-sharp", "src"),
        ("scala", "src"),
        ("lua", "src"),
        ("bash", "src"),
    ];
    let mut extracted = HashSet::new();
    for (index, (language, source)) in grammars.into_iter().enumerate() {
        let archive = Path::new("grammars").join(format!("{language}.tar.gz"));
        println!("cargo:rerun-if-changed={}", archive.display());
        let root = output.join(language);
        if extracted.insert(language) {
            if root.exists() {
                fs::remove_dir_all(&root).expect("remove stale extracted grammar");
            }
            let decoder =
                flate2::read::GzDecoder::new(File::open(&archive).expect("frozen grammar archive"));
            tar::Archive::new(decoder)
                .unpack(&root)
                .expect("unpack frozen grammar archive");
        }
        let source = root.join(source);
        let mut build = cc::Build::new();
        build
            .include(&source)
            .include(&root)
            .include(root.join("common"))
            .warnings(false)
            .flag_if_supported("-std=c11")
            .file(source.join("parser.c"));
        let scanner = source.join("scanner.c");
        if scanner.is_file() {
            build.file(scanner);
        }
        build.compile(&format!("differens_grammar_{index}"));
    }
}
