import { useState, useRef, useEffect, useCallback, useReducer } from 'react'
import { DiffFile } from '../../../shared/types'

interface FileTreeProps {
  files: DiffFile[]
  focusedFile?: string
  onFileClick: (filePath: string) => void
}

interface TreeNode {
  name: string
  fullPath: string
  children: Map<string, TreeNode>
  file?: DiffFile
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          children: new Map(),
        })
      }
      current = current.children.get(part)!
    }
    current.file = file
  }
  return root
}

function DirectoryNode({
  node,
  focusedFile,
  onFileClick,
  depth,
}: {
  node: TreeNode
  focusedFile?: string
  onFileClick: (filePath: string) => void
  depth: number
}) {
  const [expanded, setExpanded] = useState(true)
  const entries = Array.from(node.children.values())
  const dirs = entries.filter((n) => !n.file)
  const files = entries.filter((n) => n.file)

  return (
    <div className="rv-file-tree-dir">
      <button
        type="button"
        className="rv-file-tree-dir-label"
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="rv-file-tree-arrow">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="rv-file-tree-dir-name">{node.name}/</span>
      </button>
      {expanded && (
        <div>
          {dirs.map((dir) => (
            <DirectoryNode
              key={dir.fullPath}
              node={dir}
              focusedFile={focusedFile}
              onFileClick={onFileClick}
              depth={depth + 1}
            />
          ))}
          {files.map((fileNode) => (
            <FileNode
              key={fileNode.fullPath}
              node={fileNode}
              focusedFile={focusedFile}
              onFileClick={onFileClick}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FileNode({
  node,
  focusedFile,
  onFileClick,
  depth,
}: {
  node: TreeNode
  focusedFile?: string
  onFileClick: (filePath: string) => void
  depth: number
}) {
  const file = node.file!
  const isFocused = focusedFile === file.path

  return (
    <button
      type="button"
      className={`rv-file-tree-file${isFocused ? ' rv-file-tree-file--focused' : ''}`}
      style={{ paddingLeft: depth * 16 + 26 }}
      onClick={() => onFileClick(file.path)}
    >
      <span className="rv-file-tree-file-name">{node.name}</span>
    </button>
  )
}

export default function FileTree({ files, focusedFile, onFileClick }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useReducer(
    (_state: { narrow: boolean }, width: number) => ({ narrow: width < 700 }),
    { narrow: false }
  )

  const handleResize = useCallback((entries: ResizeObserverEntry[]) => {
    for (const entry of entries) {
      setLayout(entry.contentRect.width)
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(handleResize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [handleResize])

  const tree = buildTree(files)
  const entries = Array.from(tree.children.values())
  const dirs = entries.filter((n) => !n.file)
  const topFiles = entries.filter((n) => n.file)

  if (layout.narrow) {
    return (
      <div ref={containerRef} className="rv-file-tree">
        <select
          className="rv-file-tree-dropdown"
          value={focusedFile ?? ''}
          onChange={(e) => onFileClick(e.target.value)}
        >
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="rv-file-tree">
      {dirs.map((dir) => (
        <DirectoryNode
          key={dir.fullPath}
          node={dir}
          focusedFile={focusedFile}
          onFileClick={onFileClick}
          depth={0}
        />
      ))}
      {topFiles.map((fileNode) => (
        <FileNode
          key={fileNode.fullPath}
          node={fileNode}
          focusedFile={focusedFile}
          onFileClick={onFileClick}
          depth={0}
        />
      ))}
    </div>
  )
}
