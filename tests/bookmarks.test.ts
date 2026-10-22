import { describe, expect, it } from 'vitest'
import { parseBookmarks } from '../src/main/bookmarks'

const sample = JSON.stringify({
  roots: {
    bookmark_bar: {
      type: 'folder', name: 'Bookmarks bar', children: [
        { type: 'url', name: 'GitHub', url: 'https://github.com/' },
        { type: 'folder', name: 'Work', children: [
          { type: 'url', name: 'Supabase', url: 'https://supabase.com/dashboard' },
          { type: 'folder', name: 'Deep', children: [{ type: 'url', name: 'CF', url: 'https://dash.cloudflare.com/' }] }
        ] },
        { type: 'url', name: 'local', url: 'chrome://settings' }
      ]
    },
    other: { type: 'folder', name: 'Other', children: [{ type: 'url', name: 'Docs', url: 'https://docs.aside.com/' }] },
    synced: { type: 'folder', name: 'Mobile', children: [] }
  }
})

describe('parseBookmarks', () => {
  it('flattens folders into paths and skips non-http urls', () => {
    expect(parseBookmarks(sample)).toEqual([
      { folder: 'Bookmarks bar', title: 'GitHub', url: 'https://github.com/' },
      { folder: 'Bookmarks bar/Work', title: 'Supabase', url: 'https://supabase.com/dashboard' },
      { folder: 'Bookmarks bar/Work/Deep', title: 'CF', url: 'https://dash.cloudflare.com/' },
      { folder: 'Other', title: 'Docs', url: 'https://docs.aside.com/' }
    ])
  })
  it('returns [] on garbage', () => {
    expect(parseBookmarks('not json')).toEqual([])
  })
})
