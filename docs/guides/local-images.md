# Import and export local images

> Parent: [User guides](./README.md)

Language: [简体中文](./local-images.zh-CN.md)

Use the Codex Plugin to edit local images and save results as files for other tools.

Complete [Plugin configuration](./configuration.md) in the project containing your images. Your installation must provide `import_local_image` and `export_image_artifact`; ask Codex to check whether they are available. Available tools depend on the installed version. Check the target version's [changelog](../../CHANGELOG.md) before following the [update guide](./updating.md).

## Edit an existing image

1. Copy the image into your project, for example at `references/character.png`.
2. In the conversation, give its path and describe the change:

> Edit references/character.png so the character is running to the right. Keep the character's appearance and clothing.

With API Key authentication, the selected model must support image editing. Using several references also requires multi-reference support. The Atlas protocol supports text-to-image generation only and cannot perform this edit.

With the ChatGPT route, Codex first displays a result card for the imported image. Open its canvas, describe the change, and submit. This route requires image generation to be available in Codex App; see [configuration](./configuration.md).

The edited image appears in the conversation as a new version linked to the original. The source file in your project remains unchanged.

You can import PNG, JPEG, and WebP images up to 64 MiB and 100 million pixels each. Import saves a copy; importing the same file again creates a separate image. Import and export run locally. Editing sends a request to the selected image service.

## Send a result to a local tool

Select a result and specify a new filename:

> Export this image to exports/running-right.png.

The file will appear in your project's `exports/` directory, ready for other tools. Missing directories are created automatically. If the file already exists, choose another filename.

Export preserves the image's original format and contents. It does not convert formats, so the filename extension must match the image format. For resizing, transparency, or grid splitting, ask Codex to process the image first, then export the processed result. These local Plugin operations currently accept PNG images only.

## File locations and troubleshooting

On Windows, macOS, and Linux, use paths relative to the project root, such as `references/character.png`, with forward slashes `/`. Copy images from outside the project into it before importing them. Absolute paths, paths containing `..`, symbolic links, and Windows junctions are not supported.

Keep import and export locations separate from the Plugin-managed image directory. Its default location is `output/imagegen/` and can be changed in [configuration](./configuration.md). Images already shown in result cards can be edited directly; you do not need to import them from that directory.

For a blank canvas, configuration errors, or other problems, see [troubleshooting](./troubleshooting.md).
