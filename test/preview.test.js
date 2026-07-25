import assert from 'node:assert/strict'
import { test } from 'node:test'

import { previewInfo, formatBytes } from '../server/preview.js'

test('이미지 확장자는 mime과 함께 돌아온다', () => {
  assert.deepEqual(previewInfo('assets/logo.png'), { kind: 'image', mime: 'image/png' })
  assert.equal(previewInfo('a/b/photo.jpeg').mime, 'image/jpeg')
  assert.equal(previewInfo('icon.svg').mime, 'image/svg+xml')
  assert.equal(previewInfo('anim.gif').mime, 'image/gif')
})

test('대소문자를 가리지 않는다', () => {
  assert.equal(previewInfo('LOGO.PNG')?.mime, 'image/png')
  assert.equal(previewInfo('Shot.JPG')?.mime, 'image/jpeg')
})

test('표에 없는 형식은 미리보기를 하지 않는다', () => {
  // Content-Type이 이 판단에서 나오므로, 모르는 확장자를 흘려보내면 안 된다
  assert.equal(previewInfo('src/app.js'), null)
  assert.equal(previewInfo('doc.pdf'), null)
  assert.equal(previewInfo('video.mp4'), null)
  assert.equal(previewInfo('archive.png.gz'), null)
})

test('확장자가 없거나 점파일이면 null', () => {
  assert.equal(previewInfo('Makefile'), null)
  assert.equal(previewInfo('.gitignore'), null)
  assert.equal(previewInfo('assets/.keep'), null)
  assert.equal(previewInfo(''), null)
  assert.equal(previewInfo(null), null)
})

test('경로에 점이 있어도 마지막 확장자만 본다', () => {
  assert.equal(previewInfo('v1.2/icon.png')?.mime, 'image/png')
  assert.equal(previewInfo('my.folder/file.svg')?.mime, 'image/svg+xml')
})

test('크기는 사람이 읽는 단위로', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(9_999), '9.8 KB')
  assert.equal(formatBytes(132_308), '129 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(-1), null)
  assert.equal(formatBytes(undefined), null)
})
