/**
 * Trim-Transcript 策略引擎的 golden 对照测试。
 *
 * 逐条自 Claw `test/trim-compact-fixes.test.js` 移植，断言与 Claw 完全一致。
 * 用于验收框架 trim 引擎（src/core/continuity/transforms/trim-transcript.ts）
 * 与 Claw 现行实现（server/context-continuity/handoff-package.js）逐字节等价。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildTrimmedSeedMessages,
  normalizeExportPolicy,
  DEFAULT_EXPORT_POLICY,
} from '../core/continuity/transforms/index.js';

describe('trim-compact fixes (golden, ported from Claw)', () => {

  describe('Fix 3: foldedToolNoteRole default is system (not assistant)', () => {
    it('defaults to system in DEFAULT_EXPORT_POLICY', () => {
      assert.equal(DEFAULT_EXPORT_POLICY.foldedToolNoteRole, 'system');
    });

    it('normalizeExportPolicy returns system when not specified', () => {
      const policy = normalizeExportPolicy({});
      assert.equal(policy.foldedToolNoteRole, 'system');
    });

    it('respects explicit assistant override', () => {
      const policy = normalizeExportPolicy({ foldedToolNoteRole: 'assistant' });
      assert.equal(policy.foldedToolNoteRole, 'assistant');
    });
  });

  describe('Fix: fullPreserveFromTurn=0 preserves all (by design)', () => {
    it('preserves all messages when fullPreserveFromTurn=0', () => {
      const messages = [
        { role: 'user', content: 'hello', turn: 0 },
        { role: 'assistant', content: 'hi', turn: 0, toolCalls: [{ name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      assert.equal(stats.keptSeedMessageCount, 5, 'all 5 messages should be in preserve zone');
      assert.equal(stats.foldedToolCallCount, 0, 'no folding should occur');
    });
  });

  describe('trim with fullPreserveFromTurn > 0 folds earlier turns', () => {
    it('folds tool activity in turns before preserve boundary', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: 'doing stuff', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply to second', turn: 1 },
        { role: 'user', content: 'third', turn: 2 },
        { role: 'assistant', content: 'reply to third', turn: 2 },
      ];
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 2 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const preservedUserMessages = seedMessages.filter(m => m.role === 'user');
      assert.ok(preservedUserMessages.some(m => m.content === 'third'), 'turn 2 user message preserved');

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'should have a fold note for tool activity in fold zone');
      assert.ok(stats.foldedToolCallCount > 0, 'tool calls should be folded');

      assert.equal(foldNotes[0].role, 'system', 'fold note role should be system');

      const toolMessages = seedMessages.filter(m => m.role === 'tool');
      assert.equal(toolMessages.length, 0, 'no raw tool messages should survive in fold zone');
    });
  });

  describe('preservedTurns: non-contiguous turn preservation', () => {
    it('preserves ONLY specified turns, folds the rest', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: 'doing stuff', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1, toolCalls: [{ name: 'edit', arguments: '{"filePath":"b.js"}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"success":true}', turn: 1 },
        { role: 'user', content: 'third', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [0] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const turn0Assistant = seedMessages.find(m => m.role === 'assistant' && m.turn === 0);
      assert.ok(turn0Assistant, 'turn 0 assistant should be preserved');
      assert.ok(turn0Assistant.toolCalls, 'turn 0 assistant should keep toolCalls (preserve zone)');

      const turn0Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 0);
      assert.ok(turn0Tool, 'turn 0 tool message should be preserved');

      assert.ok(stats.foldedToolCallCount > 0, 'tool calls from turns 1+ should be folded');

      const turn1Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 1);
      assert.ok(!turn1Tool, 'turn 1 tool message should NOT be preserved (it is in fold zone)');

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'should have fold notes for folded turns');
    });

    it('preserves tool-result images only for explicitly preserved turns', () => {
      const managedImage = {
        path: 'C:/managed-images/hash.png',
        mediaType: 'image/png',
        source: 'C:/workspace/original.png',
      };
      const messages = [
        { role: 'user', content: 'read old image', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_old', name: 'read_image', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_old', content: '{"success":true}', turn: 0, images: [managedImage] },
        { role: 'user', content: 'read current image', turn: 1 },
        { role: 'assistant', content: '', turn: 1, toolCalls: [{ id: 'tc_keep', name: 'read_image', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_keep', content: '{"success":true}', turn: 1, images: [managedImage] },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      assert.ok(!seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_old'),
        'folded turn must not retain the old tool image');
      const preserved = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_keep');
      assert.ok(preserved, 'explicitly preserved tool result should survive trim');
      assert.deepEqual((preserved as any).images, [managedImage]);
    });

    it('preservedTurns takes precedence over fullPreserveFromTurn', () => {
      const messages = [
        { role: 'user', content: 'msg0', turn: 0 },
        { role: 'assistant', content: 'reply0', turn: 0, toolCalls: [{ name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{}', turn: 0 },
        { role: 'user', content: 'msg1', turn: 1 },
        { role: 'assistant', content: 'reply1', turn: 1 },
        { role: 'user', content: 'msg2', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2, toolCalls: [{ name: 'edit', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{}', turn: 2 },
      ];
      const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0, preservedTurns: [2] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const turn2Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 2);
      assert.ok(turn2Tool, 'turn 2 tool should be preserved (in preservedTurnSet)');

      const turn0Tool = seedMessages.find(m => m.role === 'tool' && m.turn === 0);
      assert.ok(!turn0Tool, 'turn 0 tool should NOT be preserved (preservedTurns overrides fullPreserveFromTurn)');
      assert.ok(stats.foldedToolCallCount > 0, 'turn 0 tool calls should be folded');
    });
  });

  describe('Fix: consecutive tool-only assistant turns merge into one fold', () => {
    it('produces a single fold note for consecutive tool-only assistant messages', () => {
      const messages = [
        { role: 'user', content: 'fix the bug', turn: 0 },
        { role: 'assistant', content: 'Let me investigate.', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"result":"match found"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"result":"another match"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc3', content: '{"result":"done"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc4', content: '{"result":"file content"}', turn: 0 },
        { role: 'assistant', content: 'Found the issue.', turn: 0 },
        { role: 'user', content: 'great', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.equal(foldNotes.length, 1, 'consecutive tool-only turns should produce exactly ONE fold note');
      assert.ok(foldNotes[0].content.includes('grep'), 'fold should contain grep');
      assert.ok(foldNotes[0].content.includes('bash'), 'fold should contain bash');
      assert.ok(foldNotes[0].content.includes('read'), 'fold should contain read');
      assert.equal(stats.foldedToolNoteCount, 1, 'only one foldedToolNoteCount');
      assert.equal(stats.foldedToolCallCount, 4, 'all 4 tool calls folded');
    });

    it('still separates folds when assistant text appears between tool calls', () => {
      const messages = [
        { role: 'user', content: 'do task', turn: 0 },
        { role: 'assistant', content: 'Step 1.', turn: 0, toolCalls: [{ name: 'grep', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{}', turn: 0 },
        { role: 'assistant', content: 'Step 2.', turn: 0, toolCalls: [{ name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{}', turn: 0 },
        { role: 'user', content: 'ok', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.equal(foldNotes.length, 2, 'text between tool calls should produce separate folds');
    });
  });

  function assertReplayedToolCallsArePaired(seedMessages: any[]) {
    const callIds = new Set();
    const outputIds = new Set();
    for (const message of seedMessages) {
      for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
        if (call?.id) callIds.add(call.id);
      }
      if (message?.role === 'tool' && message.toolCallId) {
        outputIds.add(message.toolCallId);
      }
    }
    assert.deepEqual([...callIds].sort(), [...outputIds].sort(),
      'every replayed tool call must have exactly one replayed tool output');
  }

  describe('Continuity protected tools', () => {
    it('preserves protected tool calls and their tool results outside the normal preserve window', () => {
      const messages = [
        { role: 'user', content: 'plan this', turn: 0 },
        {
          role: 'assistant',
          content: '',
          turn: 0,
          toolCalls: [
            { id: 'tc_todo', name: 'task_update', arguments: '{"id":"1","status":"in_progress"}' },
            { id: 'tc_read', name: 'read', arguments: '{"filePath":"a.js"}' },
          ],
        },
        { role: 'tool', toolCallId: 'tc_todo', content: '{"ok":true}', turn: 0 },
        { role: 'tool', toolCallId: 'tc_read', content: '{"result":"file"}', turn: 0 },
        { role: 'user', content: 'continue', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({
        preservedTurns: [1],
        preserveToolNames: ['task_update'],
      });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const protectedAssistant = seedMessages.find(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.name === 'task_update'));
      assert.ok(protectedAssistant, 'assistant message containing task_update should survive trim');
      assert.deepEqual((protectedAssistant as any).toolCalls.map((tc: any) => tc.id), ['tc_todo'],
        'mixed assistant batches must replay only calls whose outputs are preserved');
      assert.ok(seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_todo'), 'task_update tool result should survive trim');
      assert.ok(!seedMessages.some(m => m.role === 'tool' && m.toolCallId === 'tc_read'), 'unprotected read result should still be foldable/droppable');
      assert.ok(seedMessages.some(m => m.tag === 'folded-tool-activity' && m.content.includes('read')),
        'unprotected calls should be represented only by the fold note');
      assertReplayedToolCallsArePaired(seedMessages);
      assert.equal(stats.keptProtectedToolCallCount, 1);
      assert.equal(stats.keptProtectedToolMessageCount, 1);
    });

    it('replays only protected calls from a mixed parallel batch', () => {
      const messages = [
        { role: 'user', content: 'inspect and plan', turn: 0 },
        {
          role: 'assistant',
          content: 'I will set up the task and inspect the file.',
          turn: 0,
          toolCalls: [
            { id: 'tc_create', name: 'task_create', arguments: { subject: 'Inspect file' } },
            { id: 'tc_read', name: 'read', arguments: { filePath: 'app.js' } },
            { id: 'tc_grep', name: 'grep', arguments: { pattern: 'TODO' } },
          ],
        },
        { role: 'tool', toolCallId: 'tc_create', content: '{"success":true}', turn: 0 },
        { role: 'tool', toolCallId: 'tc_read', content: '{"type":"file","content":"..."}', turn: 0 },
        { role: 'tool', toolCallId: 'tc_grep', content: '{"matches":[]}', turn: 0 },
      ];
      const policy = normalizeExportPolicy({ preserveToolNames: ['task_create'] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const replayedAssistant = seedMessages.find(message => message.role === 'assistant' && message.toolCalls?.length);
      assert.deepEqual((replayedAssistant as any).toolCalls.map((call: any) => call.id), ['tc_create']);
      assertReplayedToolCallsArePaired(seedMessages);
      assert.ok(seedMessages.some(message => message.tag === 'folded-tool-activity'
        && message.content.includes('read') && message.content.includes('grep')),
      'non-protected calls must remain only in the folded activity summary');
    });
  });

  describe('skill protection is message-level (not turn-level)', () => {
    it('protects only invoke_skill call and its result, NOT other tools in the same turn', () => {
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_read', name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc_read', content: '{"success":true,"result":"file content"}', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_bash', name: 'bash', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'tc_bash', content: '{"success":true,"result":"done"}', turn: 0 },
        { role: 'assistant', content: 'Finished research.', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'you are welcome', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [], keepRecentSkillInvokes: 5 });
      const { seedMessages, stats } = buildTrimmedSeedMessages(messages, policy);

      const skillAssistant = seedMessages.find(m =>
        m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some(tc => tc.name === 'invoke_skill'));
      assert.ok(skillAssistant, 'invoke_skill assistant message should be preserved');

      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(skillTool, 'invoke_skill tool result should be preserved');
      assert.deepEqual((skillAssistant as any).toolCalls.map((tc: any) => tc.id), ['tc_skill'],
        'a mixed skill batch must not replay calls whose outputs were folded');
      assertReplayedToolCallsArePaired(seedMessages);

      const readTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_read');
      assert.ok(!readTool, 'read tool result should NOT be preserved (not a skill call)');
      const bashTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_bash');
      assert.ok(!bashTool, 'bash tool result should NOT be preserved (not a skill call)');

      const foldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.ok(foldNotes.length > 0, 'non-skill tool calls should be folded');
      assert.ok(stats.foldedToolCallCount > 0, 'folded tool call count should be > 0');
    });

    it('protects skill calls even when preservedTurns is null (default behavior)', () => {
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'welcome', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ keepRecentSkillInvokes: 5 });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(skillTool, 'skill tool result should be preserved when preservedTurns is null');
    });

    it('does NOT protect skill calls when keepRecentSkillInvokes is disabled', () => {
      const messages = [
        { role: 'user', content: 'do research', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ id: 'tc_skill', name: 'invoke_skill', arguments: '{"skill":"test"}' }] },
        { role: 'tool', toolCallId: 'tc_skill', content: '{"success":true,"result":"skill content"}', turn: 0 },
        { role: 'user', content: 'thanks', turn: 1 },
        { role: 'assistant', content: 'welcome', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ keepRecentSkillInvokes: null });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const skillTool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc_skill');
      assert.ok(!skillTool, 'skill tool result should NOT be preserved when keepRecentSkillInvokes is null');
    });
  });

  describe('Fix 1: seed feature turn collision verification (logic)', () => {
    it('computes correct _callIndex = maxTurn + 1 for non-colliding user turn', () => {
      const seedMessages = [
        { role: 'user', content: 'msg0', turn: 0 },
        { role: 'assistant', content: 'reply0', turn: 0 },
        { role: 'user', content: 'msg1', turn: 1 },
        { role: 'assistant', content: 'reply1', turn: 1 },
        { role: 'user', content: 'msg2', turn: 2 },
        { role: 'assistant', content: 'reply2', turn: 2 },
      ];

      let fallbackTurn = 0;
      let injectionTurn = fallbackTurn;
      for (const message of seedMessages) {
        const turn = typeof message.turn === 'number' ? message.turn : fallbackTurn;
        injectionTurn = Math.max(injectionTurn, turn + 1);
      }

      const oldCallIndex = injectionTurn - 1;
      assert.equal(oldCallIndex, 2, 'old logic sets _callIndex to 2 (collides with seed turn 2)');

      const newCallIndex = injectionTurn;
      assert.equal(newCallIndex, 3, 'new logic sets _callIndex to 3 (no collision)');
    });

    it('handles seed messages without explicit turns', () => {
      const seedMessages = [
        { role: 'user', content: 'msg0' },
        { role: 'assistant', content: 'reply0' },
        { role: 'user', content: 'msg1' },
      ];

      let fallbackTurn = 0;
      let injectionTurn = fallbackTurn;
      seedMessages.forEach((message, index) => {
        const turn = typeof message.turn === 'number' ? message.turn : (fallbackTurn + index);
        injectionTurn = Math.max(injectionTurn, turn + 1);
      });

      assert.equal(injectionTurn, 3);
      assert.equal(injectionTurn - 1, 2, 'old logic would collide');
    });
  });

  // ===== tag-based system message preservation =====

  describe('keepSystemTags default', () => {
    it('includes folded-tool-activity in DEFAULT_EXPORT_POLICY', () => {
      assert.ok(DEFAULT_EXPORT_POLICY.keepSystemTags.includes('folded-tool-activity'));
    });

    it('normalizeExportPolicy keeps default keepSystemTags when not specified', () => {
      const policy = normalizeExportPolicy({});
      assert.ok(policy.keepSystemTags.includes('folded-tool-activity'));
    });

    it('normalizeExportPolicy respects explicit keepSystemTags override', () => {
      const policy = normalizeExportPolicy({ keepSystemTags: ['custom-tag'] });
      assert.deepEqual(policy.keepSystemTags, ['custom-tag']);
    });
  });

  describe('folded tool activity notes carry tag', () => {
    it('fold note has tag folded-tool-activity', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const foldNotes = seedMessages.filter(m => m.tag === 'folded-tool-activity');
      assert.ok(foldNotes.length > 0, 'should have at least one fold note with tag');

      const allFoldNotes = seedMessages.filter(m => m.content.includes('[Folded tool activity]'));
      assert.equal(foldNotes.length, allFoldNotes.length, 'all fold notes should carry the tag');
    });
  });

  describe('repeated trim preserves tagged system messages', () => {
    it('second trim does not drop fold notes from first trim', () => {
      const afterFirstTrim = [
        { role: 'user', content: 'original question', turn: 0 },
        { role: 'system', content: '[Folded tool activity]\nassistant tool calls: read(a.js)', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'follow up', turn: 1 },
        { role: 'assistant', content: 'answer', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(afterFirstTrim, policy);

      const survivingFoldNotes = seedMessages.filter(m =>
        m.tag === 'folded-tool-activity' && m.content.includes('[Folded tool activity]'));
      assert.ok(survivingFoldNotes.length > 0,
        'fold note with tag folded-tool-activity must survive second trim');
    });

    it('untagged system messages are still dropped by default', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'some runtime reminder without tag', turn: 0 },
        { role: 'assistant', content: 'reply', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply2', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const survivingUntaggedSystem = seedMessages.filter(m =>
        m.role === 'system' && !m.tag);
      assert.equal(survivingUntaggedSystem.length, 0,
        'untagged system messages should be dropped');
    });

    it('includeSystemMessages=true overrides keepSystemTags and keeps all system messages', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'untagged reminder', turn: 0 },
        { role: 'system', content: 'tagged note', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [1], includeSystemMessages: true });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const systemMessages = seedMessages.filter(m => m.role === 'system');
      assert.ok(systemMessages.length >= 2, 'both system messages should survive');
    });
  });

  describe('preserve zone passes tag through unchanged', () => {
    it('preserved system messages keep their tag', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'system', content: 'tagged note', turn: 0, tag: 'folded-tool-activity' },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1 },
      ];

      const policy = normalizeExportPolicy({ preservedTurns: [0, 1] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const taggedSystem = seedMessages.find(m =>
        m.role === 'system' && m.tag === 'folded-tool-activity');
      assert.ok(taggedSystem, 'preserved system message should retain its tag');
    });
  });

  describe('preservedMsgRanges: message-index-based preservation', () => {
    it('preserves tool messages at specified indices, folds the rest', () => {
      const messages = [
        { role: 'user', content: 'first', turn: 0 },
        { role: 'assistant', content: 'a0', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
        { role: 'user', content: 'second', turn: 1 },
        { role: 'assistant', content: 'a1', turn: 1, toolCalls: [{ name: 'read', arguments: '{"filePath":"b.js"}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"success":true}', turn: 1 },
        { role: 'user', content: 'third', turn: 2 },
        { role: 'assistant', content: 'a2', turn: 2, toolCalls: [{ name: 'read', arguments: '{"filePath":"c.js"}' }] },
        { role: 'tool', toolCallId: 'tc3', content: '{"success":true}', turn: 2 },
      ];
      const policy = normalizeExportPolicy({ preservedMsgRanges: [[6, 8]] });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const tc3 = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc3');
      assert.ok(tc3, 'tool result in preserved range should be kept as-is');

      const tc1 = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc1');
      const tc2 = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc2');
      assert.ok(!tc1, 'tool result outside preserved range should be folded/dropped');
      assert.ok(!tc2, 'tool result outside preserved range should be folded/dropped');
    });

    it('takes precedence over preservedTurns when both are set', () => {
      const messages = [
        { role: 'user', content: 'initial', turn: 1 },
        { role: 'assistant', content: 'working', turn: 1, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 1 },
        { role: 'user', content: 'queued input', turn: 1 },
        { role: 'assistant', content: 'reply', turn: 1, toolCalls: [{ name: 'read', arguments: '{"filePath":"b.js"}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"success":true}', turn: 1 },
      ];
      const policy = normalizeExportPolicy({
        preservedTurns: [1],
        preservedMsgRanges: [[3, 5]],
      });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const tc1 = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc1');
      assert.ok(!tc1, 'tc1 outside preservedMsgRange should be folded even though turn matches preservedTurns');

      const tc2 = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc2');
      assert.ok(tc2, 'tc2 inside preservedMsgRange should be preserved');
    });

    it('correctly handles same-turn multiple user messages (the bug scenario)', () => {
      const messages = [
        { role: 'user', content: 'hello', turn: 0 },
        { role: 'assistant', content: 'hi', turn: 0 },
        { role: 'user', content: 'do task', turn: 1 },
        { role: 'assistant', content: 'working', turn: 1, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 1 },
        { role: 'user', content: 'also check b.js', turn: 1 },
        { role: 'assistant', content: 'ok', turn: 1, toolCalls: [{ name: 'read', arguments: '{"filePath":"b.js"}' }] },
        { role: 'tool', toolCallId: 'tc2', content: '{"success":true}', turn: 1 },
        { role: 'assistant', content: 'done', turn: 1 },
      ];
      const policy = normalizeExportPolicy({
        preservedMsgRanges: [[5, 8]],
      });
      const { seedMessages } = buildTrimmedSeedMessages(messages, policy);

      const doTaskUser = seedMessages.find(m => m.role === 'user' && m.content === 'do task');
      assert.ok(!doTaskUser || !doTaskUser.toolCalls,
        'first user message in turn 1 should not be in preserve zone');

      const queuedUser = seedMessages.find(m => m.role === 'user' && m.content === 'also check b.js');
      assert.ok(queuedUser, 'queued user message should be preserved');

      const tc2Tool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc2');
      assert.ok(tc2Tool, 'tool result for preserved range should be kept');

      const tc1Tool = seedMessages.find(m => m.role === 'tool' && m.toolCallId === 'tc1');
      assert.ok(!tc1Tool, 'tool result outside preserved range should be folded/dropped');
    });
  });
});
