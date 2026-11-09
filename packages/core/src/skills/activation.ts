import type { Message } from '../core/types.js';

/** Skill injection identity is carried by source/tag, never inferred from document text. */
export function isSkillActivationMessage(message: Pick<Message, 'role' | 'source' | 'tag'>): boolean {
  if (message?.role !== 'system') return false;
  if (message.source === 'skill') return true;
  const tag = message.tag;
  return message.source === 'handoff-seed' && !!tag && typeof tag === 'object'
    && !Array.isArray(tag) && tag.kind === 'skill-activation';
}

export function readSkillActivationName(message: Pick<Message, 'role' | 'source' | 'tag'>): string | null {
  if (message?.role !== 'system' || (message.source !== 'skill' && message.source !== 'handoff-seed')) return null;
  const tag = message.tag;
  if (!tag || typeof tag !== 'object' || Array.isArray(tag) || tag.kind !== 'skill-activation') return null;
  return typeof tag.skill === 'string' && tag.skill.trim() ? tag.skill.trim() : null;
}
