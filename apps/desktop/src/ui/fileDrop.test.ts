import { afterEach, describe, expect, it } from 'vitest';
import { imagePathsFrom, withPaths } from './fileDrop';

const drop = (files: File[]) => ({ files } as unknown as DataTransfer);
const img = (name: string) => new File([''], name, { type: 'image/png' });

describe('imagePathsFrom', () => {
  afterEach(() => Reflect.deleteProperty(window, 'relay'));

  it('takes the images from a drop and leaves everything else', () => {
    Object.assign(window, { relay: { pathForFile: (f: File) => `/shots/${f.name}` } });
    const files = [img('a.png'), new File([''], 'notes.txt', { type: 'text/plain' }), img('b.png')];
    expect(imagePathsFrom(drop(files))).toEqual(['/shots/a.png', '/shots/b.png']);
  });

  it('yields nothing when the path cannot be resolved', () => {
    expect(imagePathsFrom(drop([img('a.png')]))).toEqual([]);
    Object.assign(window, { relay: { pathForFile: () => '' } });
    expect(imagePathsFrom(drop([img('a.png')]))).toEqual([]);
    expect(imagePathsFrom(null)).toEqual([]);
  });
});

describe('withPaths', () => {
  it('adds each path on its own line after what was typed', () => {
    expect(withPaths('look at this', ['/shots/a.png'])).toBe('look at this\n/shots/a.png\n');
    expect(withPaths('', ['/a.png', '/b.png'])).toBe('/a.png\n/b.png\n');
    expect(withPaths('unchanged', [])).toBe('unchanged');
  });
});
