//! In-process binary plugins receive original bytes without text conversion.
use differens_core::EditAction;
use std::sync::{Arc, OnceLock, RwLock};

pub trait BinaryDiffPlugin: Send + Sync {
    fn id(&self) -> &str;
    fn extensions(&self) -> &[&str];
    /// Return semantic actions, or decline the input format.
    ///
    /// # Errors
    /// Return an error when the plugin cannot process the data; the next plugin is tried.
    fn diff(
        &self,
        old: &[u8],
        new: &[u8],
    ) -> Result<Option<Vec<EditAction>>, Box<dyn std::error::Error + Send + Sync>>;
}
fn plugins() -> &'static RwLock<Vec<Arc<dyn BinaryDiffPlugin>>> {
    static PLUGINS: OnceLock<RwLock<Vec<Arc<dyn BinaryDiffPlugin>>>> = OnceLock::new();
    PLUGINS.get_or_init(RwLock::default)
}
pub fn register_binary_plugin(plugin: Arc<dyn BinaryDiffPlugin>) {
    plugins()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(plugin);
}
pub fn unregister_binary_plugin(id: &str) -> bool {
    let mut plugins = plugins()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(index) = plugins.iter().position(|plugin| plugin.id() == id) {
        plugins.remove(index);
        true
    } else {
        false
    }
}
pub(crate) fn binary_plugins_for(extension: &str) -> Vec<Arc<dyn BinaryDiffPlugin>> {
    plugins()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|plugin| {
            plugin
                .extensions()
                .iter()
                .any(|ext| ext.eq_ignore_ascii_case(extension))
        })
        .cloned()
        .collect()
}
#[must_use]
pub fn is_binary_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "mp3"
            | "wav"
            | "flac"
            | "ogg"
            | "mp4"
            | "mov"
            | "webm"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "bin"
            | "wasm"
            | "o"
            | "a"
            | "pdf"
            | "zip"
            | "tar"
            | "gz"
            | "7z"
            | "bz2"
            | "xz"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "eot"
    )
}
