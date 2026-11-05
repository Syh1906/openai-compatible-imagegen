import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { outputSchema } from '../../mcp/image-tool-schemas.mjs';
import { withClient, artifact, assertToolErrorCode } from '../support/mcp-tool-client.mjs';

test('generation schema accepts GIF and SVG with native parameters', () => {
  for (const format of ['gif', 'svg']) {
    const value = z.object(outputSchema).parse({format, parameters:{complexity:'medium'}});
    assert.equal(value.format, format);
  }
});

test('extended originals use widget previews and reject the raster editor', async () => {
  const id = 'img_01J00000000000000000000000';
  for (const mimeType of ['image/gif', 'image/svg+xml']) {
    await withClient({ readArtifact: async () => ({ metadata: { ...artifact(id), mimeType }, data: 'b3JpZ2luYWw=' }) }, async (client) => {
      const rendered = await client.callTool({ name: 'render_image_results', arguments: { imageIds: [id] } });
      assert.equal(rendered.isError, undefined);
      assert.equal(rendered.structuredContent.artifacts[0].mimeType, mimeType);
      assert.ok(rendered._meta.ui.resourceUri);
      assert.equal(rendered.content.some((item) => item.type === 'image'), false);
      const data = await client.callTool({ name: 'read_image_artifact_data', arguments: { imageId: id } });
      assert.equal(data._meta.widgetData.dataBase64, 'b3JpZ2luYWw=');
      assertToolErrorCode(await client.callTool({ name: 'open_image_editor', arguments: { imageId: id } }), 'unsupported_capability');
    });
  }
});
