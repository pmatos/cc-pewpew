const SCALAR_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'] as const

const PATH_LIST_VARS = [
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'PATH',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERLLIB',
  'PERL5LIB',
  'GIO_MODULE_DIR',
  'GSETTINGS_SCHEMA_DIR',
  'GST_PLUGIN_SYSTEM_PATH',
  'GDK_PIXBUF_MODULE_FILE',
  'QT_PLUGIN_PATH',
] as const

const MOUNT_PREFIX_RE = /^\/tmp\/\.mount_[^/]+(\/|$)/

function isAppImageEntry(entry: string, appDir: string | undefined): boolean {
  // Empty entries in LD_LIBRARY_PATH/PATH-style lists mean "current dir" — never
  // safe to forward, so treat them as drop-able alongside actual AppImage paths.
  if (entry === '') return true
  if (appDir && (entry === appDir || entry.startsWith(`${appDir}/`))) return true
  return MOUNT_PREFIX_RE.test(entry)
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined) return env
  const out: NodeJS.ProcessEnv = { ...env }
  const appDir = env.APPDIR

  for (const key of PATH_LIST_VARS) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const kept = value.split(':').filter((entry) => !isAppImageEntry(entry, appDir))
    if (kept.length === 0) {
      delete out[key]
    } else {
      out[key] = kept.join(':')
    }
  }

  for (const key of SCALAR_VARS) delete out[key]
  for (const key of Object.keys(out)) {
    if (key.startsWith('APPIMAGE_')) delete out[key]
  }
  return out
}
