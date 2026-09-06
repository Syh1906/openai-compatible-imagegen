# Import and export local images

> Parent: [User guides](./README.md)

Language: [简体中文](./local-images.zh-CN.md)

The Codex Plugin can use existing project images as edit references and export generated, edited, or delivered images for local tools. Complete [configuration](./configuration.md) first and start the task in the project containing your images.

## Edit an existing image

Place an image at `references/character.png` in your project and ask:

> Use references/character.png as the character reference. Create a running-right pose while preserving its appearance.

The Agent calls `import_local_image` to obtain a stable image ID, then edits through the selected route. API Key edits pass that ID as `edit_image.parentImageId`; additional references are imported separately and passed as `referenceImageIds`. With the ChatGPT route, open the canvas from the imported image's result card and submit an edit.

Import accepts PNG, JPEG, and WebP up to 64 MiB and 100 million pixels per image. It saves an exact snapshot without modifying the source; each import creates an independent artifact. Import itself makes no image-service request and does not change the authentication route.

## Send a result to a local tool

Select a result and specify a new filename:

> Export this image to decoded/running-right.png for spritesheet assembly.

The Agent calls `export_image_artifact`, which returns the relative destination, byte count, and SHA-256. Missing parent directories are created. Existing files are never overwritten; choose a new filename if the destination exists. Export does not transcode: the extension must match the actual image format. For resizing, transparency, or grid splitting, finish delivery first and export the selected derivative.

## Paths and entry points

On Windows, macOS, and Linux, tool arguments use project-relative paths with forward slashes. Source and destination paths must stay inside the bound project and outside its artifact repository. Absolute paths, `..`, symbolic links, junctions, and other reparse points are rejected. Move or copy external images into the project before importing them.

These operations use Plugin MCP tools. The Standalone Skill is a separate distribution with its own configuration; there is no need to find scripts in the Plugin installation or create `auth.json` there. If the installed version lacks the import/export tools, see the [update guide](./updating.md).
