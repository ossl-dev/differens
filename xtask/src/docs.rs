use crate::Result;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};
use std::{
    collections::HashMap,
    fmt::Write,
    fs,
    path::{Path, PathBuf},
};

const CSS: &str = "body{margin:0;display:grid;grid-template-columns:17rem minmax(0,58rem);font:16px/1.65 system-ui;color:#202020;background:#fafafa}nav{padding:2rem 1rem}main{padding:2rem;min-width:0}pre{overflow:auto;padding:1rem;background:#eee}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.5rem}a{color:#075ea7}img{max-width:100%}@media(max-width:700px){body{display:block}nav{max-height:12rem;overflow:auto}main{padding:1rem}}";
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else if c.is_whitespace() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}
fn render(source: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut events: Vec<_> = Parser::new_ext(source, options).collect();
    let mut ids = HashMap::<String, usize>::new();
    for i in 0..events.len() {
        if !matches!(events[i], Event::Start(Tag::Heading { .. })) {
            continue;
        }
        let text = events[i + 1..]
            .iter()
            .take_while(|e| !matches!(e, Event::End(TagEnd::Heading(_))))
            .filter_map(|e| match e {
                Event::Text(text) | Event::Code(text) => Some(text.as_ref()),
                _ => None,
            })
            .collect::<String>();
        let base = slug(&text);
        let count = ids.entry(base.clone()).or_default();
        let id = if *count == 0 {
            base
        } else {
            format!("{base}-{count}")
        };
        *count += 1;
        if let Event::Start(Tag::Heading { id: heading_id, .. }) = &mut events[i] {
            *heading_id = Some(id.into());
        }
    }
    let mut output = String::new();
    html::push_html(&mut output, events.into_iter());
    output
}

fn mintlify_page(source: &str, title: &str) -> Result<String> {
    let heading = format!("# {title}\n");
    let body = source.strip_prefix(&heading).unwrap_or(source).trim_start();
    let description = Parser::new_ext(body, Options::ENABLE_TABLES)
        .skip_while(|event| !matches!(event, Event::Start(Tag::Paragraph)))
        .skip(1)
        .take_while(|event| !matches!(event, Event::End(TagEnd::Paragraph)))
        .filter_map(|event| match event {
            Event::Text(text) | Event::Code(text) => Some(text.into_string()),
            Event::SoftBreak | Event::HardBreak => Some(" ".to_owned()),
            _ => None,
        })
        .collect::<String>();
    let mut edits = Vec::new();
    for (event, range) in Parser::new_ext(body, Options::ENABLE_TABLES).into_offset_iter() {
        if let Event::Start(Tag::Link { dest_url, .. }) = event {
            let path = dest_url.split('#').next().unwrap_or(&dest_url);
            if path.starts_with('/') && path.strip_suffix(".html").is_some() {
                let destination = dest_url.replacen(".html", "", 1);
                if let Some(offset) = body[range.clone()].rfind(dest_url.as_ref()) {
                    let start = range.start + offset;
                    edits.push((start, start + dest_url.len(), destination));
                }
            }
        }
    }
    let mut body = body.to_owned();
    for (start, end, destination) in edits.into_iter().rev() {
        body.replace_range(start..end, &destination);
    }
    Ok(format!(
        "---\ntitle: {}\ndescription: {}\n---\n\n{body}",
        serde_json::to_string(title)?,
        serde_json::to_string(&description)?,
    ))
}

fn validate_mintlify_navigation(docs: &Path, pages: &[PathBuf]) -> Result<()> {
    let config: serde_json::Value = serde_json::from_slice(&fs::read(docs.join("docs.json"))?)?;
    let mut pending = vec![&config["navigation"]];
    let mut registered = std::collections::BTreeSet::new();
    while let Some(value) = pending.pop() {
        match value {
            serde_json::Value::Object(object) => {
                if let Some(pages) = object.get("pages").and_then(serde_json::Value::as_array) {
                    registered.extend(pages.iter().filter_map(serde_json::Value::as_str));
                }
                pending.extend(object.values());
            }
            serde_json::Value::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    let expected = pages
        .iter()
        .map(|path| {
            path.strip_prefix(docs.join("content"))
                .map(|path| path.with_extension("").to_string_lossy().replace('\\', "/"))
        })
        .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?;
    if !expected.iter().map(String::as_str).eq(registered) {
        return Err("Mintlify docs.json navigation must include every documentation source, with no missing pages".into());
    }
    Ok(())
}
fn page_paths(source: &Path) -> Result<Vec<PathBuf>> {
    let mut pages = Vec::new();
    for entry in walkdir::WalkDir::new(source).sort_by_file_name() {
        let entry = entry?;
        if entry.file_type().is_file() && entry.path().extension().is_some_and(|s| s == "md") {
            pages.push(entry.into_path());
        }
    }
    if pages.is_empty() {
        return Err("documentation contains no pages".into());
    }
    Ok(pages)
}
fn navigation(source: &Path) -> Result<String> {
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(source.join("navigation.json"))?)?;
    let mut output = String::new();
    for page in metadata.as_array().ok_or("navigation must be an array")? {
        let slug = page["slug"]
            .as_str()
            .ok_or("navigation page missing slug")?;
        let title = page["title"]
            .as_str()
            .ok_or("navigation page missing title")?;
        write!(
            output,
            "<li><a href=\"/{}.html\">{}</a></li>",
            escape(slug),
            escape(title)
        )?;
    }
    Ok(output)
}
fn assets(source: &Path, destination: &Path) -> Result<()> {
    let images = source.join("images");
    for entry in walkdir::WalkDir::new(&images) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let target = destination
            .join("images")
            .join(entry.path().strip_prefix(&images)?);
        fs::create_dir_all(target.parent().ok_or("asset has no parent")?)?;
        fs::copy(entry.path(), target)?;
    }
    Ok(())
}
fn redirects(docs: &Path, destination: &Path) -> Result<()> {
    let routes: serde_json::Value = serde_json::from_slice(&fs::read(docs.join("routes.json"))?)?;
    for (old, target) in routes.as_object().ok_or("routes must be an object")? {
        if old == "/" {
            continue;
        }
        let target = target.as_str().ok_or("route target must be a string")?;
        let path = destination.join(old.trim_matches('/')).join("index.html");
        fs::create_dir_all(path.parent().ok_or("redirect has no parent")?)?;
        let target = escape(target);
        fs::write(
            path,
            format!(
                "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url={target}\"><link rel=\"canonical\" href=\"{target}\"><title>Page moved</title><a href=\"{target}\">Open page</a></html>"
            ),
        )?;
    }
    Ok(())
}

pub fn build(root: &Path) -> Result<()> {
    let docs = root.join("apps/docs");
    let source = docs.join("content");
    let destination = root.join("target/site");
    let pages = page_paths(&source)?;
    validate_mintlify_navigation(&docs, &pages)?;
    let nav = navigation(&docs)?;
    for path in &pages {
        let source = fs::read_to_string(path)?;
        let body = render(&source);
        let title = source
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .unwrap_or("Differens");
        let mintlify_target = docs
            .join(path.strip_prefix(docs.join("content"))?)
            .with_extension("mdx");
        fs::create_dir_all(mintlify_target.parent().ok_or("MDX output has no parent")?)?;
        fs::write(mintlify_target, mintlify_page(&source, title)?)?;
        let target = destination
            .join(path.strip_prefix(docs.join("content"))?)
            .with_extension("html");
        fs::create_dir_all(target.parent().ok_or("page output has no parent")?)?;
        fs::write(
            target,
            format!(
                "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{} — Differens</title><style>{CSS}</style></head><body><nav aria-label=\"Documentation\"><strong>Differens</strong><ul>{nav}</ul></nav><main>{body}</main></body></html>",
                escape(title)
            ),
        )?;
    }
    assets(&docs, &destination)?;
    redirects(&docs, &destination)?;
    fs::copy(docs.join("routes.json"), destination.join("routes.json"))?;
    fs::copy(docs.join("skill.md"), destination.join("skill.md"))?;
    println!(
        "generated {} Mintlify MDX pages and built static documentation in {}",
        pages.len(),
        destination.display()
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::root;
    #[test]
    fn headings_have_stable_unique_escaped_anchors() {
        let out = render(
            "# Hello `Rust`\n\n## Hello Rust\n\n[text](#hello-rust)\n\n<script>nothing</script>",
        );
        assert!(out.contains("id=\"hello-rust\""));
        assert!(out.contains("id=\"hello-rust-1\""));
        assert_eq!(escape("<&\""), "&lt;&amp;&quot;");
    }
    #[test]
    fn shipped_docs_build_without_javascript() {
        build(&root()).unwrap();
        let html = fs::read_to_string(root().join("target/site/index.html")).unwrap();
        assert!(html.contains("<nav"));
        assert!(!html.contains("<script"));
        let mdx = fs::read_to_string(root().join("apps/docs/index.mdx")).unwrap();
        assert!(mdx.starts_with("---\ntitle: "));
        assert!(mdx.contains("\ndescription: "));
        assert!(mdx.contains("](/getting-started/installation)"));
        assert!(!mdx.contains(".html)"));
    }
    #[test]
    fn mintlify_links_use_page_slugs_without_changing_code() {
        let page = mintlify_page(
            "# Example\n\nA page.\n\n[CLI](/reference/cli.html#configuration)\n\n`[code](/reference/cli.html)`\n\n```text\n[code](/reference/cli.html)\n```\n",
            "Example",
        )
        .unwrap();
        assert!(page.contains("[CLI](/reference/cli#configuration)"));
        assert!(page.contains("`[code](/reference/cli.html)`"));
        assert!(page.contains("```text\n[code](/reference/cli.html)\n```"));
        assert!(!page.contains("# Example"));
    }
}
