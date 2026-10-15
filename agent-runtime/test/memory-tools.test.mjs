import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformTools } from '../platform-tools.mjs';
import { harnessSchema } from '../harness-plugin.mjs';
const definitions = (bot_tools) => createPlatformTools({bot_tools}, (name, description, parameters) => ({name, description, parameters}));
test('personal memory tools require task opt in and have no approval tool', () => {
  const disabled=definitions({enabled:true,memory:false});
  assert.equal(disabled.some(tool=>tool.name.startsWith('memory_')),false);
  const enabled=definitions({enabled:true,memory:true});
  assert.ok(enabled.find(tool=>tool.name==='memory_search'));
  assert.ok(enabled.find(tool=>tool.name==='memory_propose'));
  assert.equal(enabled.some(tool=>/review|approve|delete/.test(tool.name)),false);
  assert.ok(enabled.find(tool=>tool.name==='skill_propose'));
  assert.equal(definitions({enabled:false,memory:true,knowledge_assets:['asset-a']}).some(tool=>tool.name==='skill_propose'),false);
});
test('Wiki and CodeGraph tools bind their schema to explicitly selected assets in Pi and Harness', () => {
  assert.equal(definitions({enabled:true,knowledge_assets:[]}).some(tool=>tool.name==='wiki_search'),false);
  const enabled=definitions({enabled:true,knowledge_assets:['asset-a','asset-b']});
  for (const name of ['wiki_search','wiki_read','code_graph_search','code_graph_callers','code_graph_callees','code_graph_impact','code_graph_read']) {
    const tool=enabled.find(tool=>tool.name===name);
    assert.ok(tool,name);
    assert.deepEqual(tool.parameters.properties.asset_id.enum,['asset-a','asset-b']);
    assert.deepEqual(harnessSchema(tool.parameters).properties.asset_id.enum,['asset-a','asset-b']);
    assert.equal(harnessSchema(tool.parameters).additionalProperties,false);
  }
});
