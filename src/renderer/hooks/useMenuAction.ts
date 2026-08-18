import { useEffect, useRef } from 'react'
import type { MenuAction } from '../../shared/types'

type MenuActionHandlers = Partial<Record<MenuAction, () => void>>

/**
 * 订阅主进程菜单投递过来的动作。
 *
 * handlers 先存进 ref 再消费：订阅只在挂载时建立一次，
 * 调用方不必为了避免重复订阅而把每个 handler 都包一层 useCallback。
 */
export function useMenuAction(handlers: MenuActionHandlers): void {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    return window.electronAPI?.onMenuAction((action) => {
      handlersRef.current[action]?.()
    })
  }, [])
}
