import type { ReconcilerTask } from '../core/reconciler-core.ts'

export function createSettingsToolbarTask(): ReconcilerTask {
  let origin: { parent: Node; next: Node | null } | null = null
  return {
    name: 'settings-toolbar-reparent',
    scopes: ['*'],
    ensure: () => {
      const dialog = document.querySelector('[aria-modal="true"]')
      if (dialog === null) return
      const nav = dialog.querySelector(':scope > [class*="_nav"]')
      const header = dialog.querySelector('[class*="_header"]:not([class*="_headerActions"])')
      if (nav === null || header === null) return
      if (header.parentElement === nav) return
      // The dialog DOM can be rebuilt by React between mutations: refresh
      // the origin every time we actually move the header, so disposal
      // restores it where it currently belongs, not where it was first seen.
      if (header.parentElement !== null) {
        origin = { parent: header.parentElement, next: header.nextSibling }
      }
      nav.appendChild(header)
    },
    dispose: () => {
      if (origin === null) return
      const header = document.querySelector('[aria-modal="true"] [class*="_header"]:not([class*="_headerActions"])')
      if (header !== null && origin.parent.isConnected) {
        // `insertBefore` throws NotFoundError when the reference node is no
        // longer a child of the parent. React can rebuild the dialog between
        // the ensure that recorded `origin.next` and this dispose, leaving a
        // detached sibling behind while the parent itself stays connected.
        // Fall back to appendChild in that case so disposal never aborts the
        // reconciler teardown with an exception.
        if (origin.next !== null && origin.next.parentNode !== origin.parent) {
          origin.parent.appendChild(header)
        } else {
          origin.parent.insertBefore(header, origin.next)
        }
      }
      origin = null
    },
  }
}
