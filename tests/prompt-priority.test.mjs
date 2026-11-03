import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest } from '../src/skills/manifest.js';
import { buildSystemPrompt } from '../src/prompt.js';

test('静态清单 priority=0 保留，并在系统提示词中排在高优先级片段后', () => {
  const { manifest } = normalizeManifest({ id: 'priority-test', prompt: { sections: [
    { id: 'last', content: 'LOW_PRIORITY_MARKER', priority: 0 },
    { id: 'first', content: 'HIGH_PRIORITY_MARKER', priority: 10 }
  ] } });
  assert.equal(manifest.prompt.sections[0].priority, 0);
  const prompt = buildSystemPrompt({ persona: {}, skillContext: {}, extraSections: manifest.prompt.sections });
  assert.ok(prompt.indexOf('HIGH_PRIORITY_MARKER') >= 0);
  assert.ok(prompt.indexOf('HIGH_PRIORITY_MARKER') < prompt.indexOf('LOW_PRIORITY_MARKER'));
});

test('静态优先级缺省和非法值回退到 50，数值上限保持 99', () => {
  const values = [undefined, null, 'bad', Infinity, 200, 0];
  const { manifest } = normalizeManifest({ id: 'priority-test', prompt: { sections: values.map((priority, i) => ({ id: String(i), content: 'text', priority })) } });
  assert.deepEqual(manifest.prompt.sections.map(s => s.priority), [50, 50, 50, 50, 99, 0]);
});
