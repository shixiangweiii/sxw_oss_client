import type { ReactNode } from 'react'

interface IconButtonProps {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
}

export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
          : 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700'
      }`}
    >
      {icon}
    </button>
  )
}
