import { describe, expect, it } from 'vitest';
import { claudeDefaultModel, claudeSettingsPath } from '../../src/models/default-model';

const HOME = '/Users/someone';
const reads = (content: string) => () => content;

describe('claudeDefaultModel', () => {
  it('reports the model a /model command saved', () => {
    expect(claudeDefaultModel(HOME, reads('{"model":"claude-fable-5-1[1m]"}'))).toBe('claude-fable-5-1[1m]');
  });

  it('says nothing is saved when the file has no model', () => {
    expect(claudeDefaultModel(HOME, reads('{"theme":"dark"}'))).toBeNull();
  });

  it('treats an empty value as nothing saved', () => {
    expect(claudeDefaultModel(HOME, reads('{"model":""}'))).toBeNull();
  });

  it('treats a missing file as nothing saved, which is where most machines are', () => {
    expect(claudeDefaultModel(HOME, () => { throw new Error('ENOENT'); })).toBeNull();
  });

  it('does not fall over on a damaged file', () => {
    expect(claudeDefaultModel(HOME, reads('{not json'))).toBeNull();
    expect(claudeDefaultModel(HOME, reads('null'))).toBeNull();
  });

  it('names the file, so the setting can be pointed at rather than described', () => {
    expect(claudeSettingsPath(HOME)).toBe('/Users/someone/.claude/settings.json');
  });
});
