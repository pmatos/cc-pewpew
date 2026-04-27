import { describe, it, expect } from 'vitest'
import { classifySshExit } from './ssh-exit-parser'
import type { SshExitReason } from '../shared/types'

interface Case {
  name: string
  exitCode: number | null
  stderr: string
  expected: SshExitReason
}

const cases: Case[] = [
  // auth failures
  {
    name: 'publickey denied',
    exitCode: 255,
    stderr: 'Permission denied (publickey).',
    expected: 'auth-failed',
  },
  {
    name: 'publickey+password denied',
    exitCode: 255,
    stderr: 'Permission denied (publickey,password).',
    expected: 'auth-failed',
  },
  {
    name: 'too many auth failures',
    exitCode: 255,
    stderr: 'Received disconnect from 10.0.0.1: Too many authentication failures',
    expected: 'auth-failed',
  },
  {
    name: 'host key verification failed',
    exitCode: 255,
    stderr: 'Host key verification failed.',
    expected: 'auth-failed',
  },
  {
    name: 'no matching host key type',
    exitCode: 255,
    stderr:
      'Unable to negotiate with 10.0.0.1 port 22: no matching host key type found. Their offer: ssh-rsa',
    expected: 'auth-failed',
  },
  {
    name: 'no supported auth methods',
    exitCode: 255,
    stderr: 'No supported authentication methods available',
    expected: 'auth-failed',
  },
  // network failures
  {
    name: 'connection refused',
    exitCode: 255,
    stderr: 'ssh: connect to host example.com port 22: Connection refused',
    expected: 'network',
  },
  {
    name: 'connection timed out',
    exitCode: 255,
    stderr: 'ssh: connect to host example.com port 22: Connection timed out',
    expected: 'network',
  },
  {
    name: 'operation timed out',
    exitCode: 255,
    stderr: 'ssh: connect to host x port 22: Operation timed out',
    expected: 'network',
  },
  {
    name: 'could not resolve hostname',
    exitCode: 255,
    stderr: 'ssh: Could not resolve hostname foo: Name or service not known',
    expected: 'network',
  },
  {
    name: 'no route to host',
    exitCode: 255,
    stderr: 'ssh: connect to host 10.0.0.1 port 22: No route to host',
    expected: 'network',
  },
  {
    name: 'network unreachable',
    exitCode: 255,
    stderr: 'ssh: connect to host x port 22: Network is unreachable',
    expected: 'network',
  },
  {
    name: 'temporary DNS failure',
    exitCode: 255,
    stderr: 'ssh: Could not resolve hostname foo: Temporary failure in name resolution',
    expected: 'network',
  },
  // dep-missing
  {
    name: 'socat missing (exit 127)',
    exitCode: 127,
    stderr: 'bash: socat: command not found',
    expected: 'dep-missing',
  },
  // bind-unlink (remote sshd lacks `StreamLocalBindUnlink yes`)
  {
    name: 'StreamLocalBindUnlink requires (single line)',
    exitCode: 255,
    stderr: 'StreamLocalBindUnlink requires StreamLocalBindUnlink yes on the server',
    expected: 'bind-unlink',
  },
  {
    name: 'StreamLocalBindUnlink with debug prefix',
    exitCode: 255,
    stderr:
      'debug1: forwarding remote socket\nStreamLocalBindUnlink requires StreamLocalBindUnlink yes',
    expected: 'bind-unlink',
  },
  // ordering: auth markers win over a co-occurring bind-unlink line
  {
    name: 'permission denied wins over bind-unlink',
    exitCode: 255,
    stderr:
      'StreamLocalBindUnlink requires StreamLocalBindUnlink yes\nPermission denied (publickey).',
    expected: 'auth-failed',
  },
  // unknown / defensive
  { name: 'empty stderr + 255', exitCode: 255, stderr: '', expected: 'unknown' },
  { name: 'null exit code (signal kill)', exitCode: null, stderr: '', expected: 'unknown' },
  // robustness: multi-line stderr with debug prefix still classifies by the auth line
  {
    name: 'multi-line with debug1 prefix',
    exitCode: 255,
    stderr:
      'debug1: Next authentication method: publickey\ndebug1: Offering public key\nPermission denied (publickey).',
    expected: 'auth-failed',
  },
]

describe('classifySshExit', () => {
  it.each(cases)('$name → $expected', ({ exitCode, stderr, expected }) => {
    expect(classifySshExit({ exitCode, stderr }).reason).toBe(expected)
  })

  it('returns ok message on exit 0', () => {
    expect(classifySshExit({ exitCode: 0, stderr: '' })).toEqual({
      reason: 'unknown',
      message: 'ok',
    })
  })

  it('uses the first non-empty stderr line as the message', () => {
    const result = classifySshExit({
      exitCode: 255,
      stderr: '\n  \ndebug1: foo\nPermission denied (publickey).',
    })
    expect(result.message).toBe('debug1: foo')
  })

  it('falls back to "ssh failed: code N" when stderr is empty', () => {
    expect(classifySshExit({ exitCode: 255, stderr: '' }).message).toBe('ssh failed: code 255')
    expect(classifySshExit({ exitCode: null, stderr: '' }).message).toBe('ssh failed: code null')
  })
})
