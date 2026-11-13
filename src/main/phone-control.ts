/** Settings → Phone control: look for phone-harness and adb on PATH and list the phones adb sees. Runs only when the owner presses Check. */
import { execFile } from 'node:child_process'
import { readPhoneCheck, type PhoneControlCheck } from '@shared/phone-control'

/** Run a tool; `found` is false only when the program is not there (a non-zero exit still means it exists). */
function run(file: string, args: string[], timeout: number): Promise<{ found: boolean; ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // a server that `adb devices` starts can keep the output pipe open past the kill: never wait on the callback alone
    const giveUp = setTimeout(() => resolve({ found: true, ok: false, out: '' }), timeout + 2000)
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      clearTimeout(giveUp)
      const code = (err as NodeJS.ErrnoException | null)?.code
      resolve({ found: code !== 'ENOENT', ok: !err, out: stdout ?? '' })
    })
  })
}

export async function phoneControlCheck(): Promise<PhoneControlCheck> {
  // `adb devices` starts the adb server when it is not running (first call can take a few seconds)
  const [harness, adb] = await Promise.all([run('phone-harness', ['--help'], 15_000), run('adb', ['devices'], 20_000)])
  return readPhoneCheck(harness.found, adb.found && adb.ok ? adb.out : undefined, adb.found)
}
