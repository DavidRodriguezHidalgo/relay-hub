import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from '../../src/approvals/approval-queue';
import { Orchestrator } from '../../src/orchestrator/orchestrator';
import { SessionStore } from '../../src/store/session-store';
import { FakeAgentClient, tick } from '../runner/fake-agent-client';

function setup(storedId: string | null = null) {
  const client = new FakeAgentClient();
  const store = new SessionStore(':memory:');
  if (storedId) store.setMeta('orchestrator.sessionId', storedId);
  const o = new Orchestrator({ cwd: '/orch', client, approvals: new ApprovalQueue(), store, tools: [] });
  return { client, store, o };
}

describe('Orchestrator', () => {
  it('starts fresh the first time and stores the new session id', async () => {
    const { client, store, o } = setup();
    await o.send('hello');
    await tick();
    expect(client.starts[0]).toMatchObject({ sessionId: null, cwd: '/orch', profile: { kind: 'orchestrator' } });
    client.init('orch-1');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBe('orch-1');
    expect(o.sessionId).toBe('orch-1');
  });

  it('resumes the stored session id', async () => {
    const { client, o } = setup('orch-9');
    await o.send('hello');
    await tick();
    expect(client.starts[0]?.sessionId).toBe('orch-9');
  });

  it('forgets a stored id whose resume failed, so the next send starts fresh', async () => {
    const { client, store, o } = setup('gone');
    await o.send('hello');
    await tick();
    client.result('error_during_execution: No conversation found');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBeNull();
    await o.send('again');
    await tick();
    expect(client.starts[1]?.sessionId).toBeNull();
  });

  it('keeps a working session id when a later turn errors', async () => {
    const { client, store, o } = setup();
    await o.send('hello');
    await tick();
    client.init('orch-1');
    client.result();
    await tick();
    await o.send('again');
    await tick();
    client.result('api error');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBe('orch-1');
  });

  it('passes its tools and system prompt in the orchestrator profile', async () => {
    const client = new FakeAgentClient();
    const tools = [{ name: 't', description: 'd', input: {}, handler: async () => ({ text: '' }) }];
    const o = new Orchestrator({ cwd: '/o', client, approvals: new ApprovalQueue(), store: new SessionStore(':memory:'), tools });
    await o.send('x');
    await tick();
    const profile = client.starts[0]?.profile;
    expect(profile?.kind).toBe('orchestrator');
    expect(profile?.kind === 'orchestrator' && profile.tools).toBe(tools);
    expect(profile?.kind === 'orchestrator' && profile.systemPrompt.length).toBeGreaterThan(0);
  });

  it('keeps a stored id that resumed fine when the first turn after restart hits a transient error', async () => {
    const { client, store, o } = setup('orch-9');
    await o.send('hello');
    await tick();
    client.init('orch-9');
    client.assistant('a', 'hi');
    client.result('overloaded_error');
    await tick();
    expect(store.getMeta('orchestrator.sessionId')).toBe('orch-9');
  });
});
