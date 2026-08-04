import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Task Chat',
  description: 'Gerencie suas tarefas por voz ou texto',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
