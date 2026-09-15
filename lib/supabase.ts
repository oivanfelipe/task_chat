import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export type Client = {
  id: string
  name: string
  segment: string | null
  services: string[]
  status: 'active' | 'paused'
  notes: string | null
  created_at: string
}

export type CallSummary = {
  id: string
  doc_id: string
  doc_name: string
  summary: string
  participants: string | null
  key_points: string[]
  action_items_count: number
  meeting_date: string | null
  client_ids: string[]
  created_at: string
}

export type DailyItem = {
  id: string
  date: string
  text: string
  done: boolean
  client_id: string | null
  created_at: string
}

export type ClientMeetingInsight = {
  id: string
  call_summary_id: string
  client_id: string
  doc_name: string
  meeting_date: string | null
  key_decisions: string[]
  open_items: string[]
  context: string | null
  created_at: string
}

export type Task = {
  id: string
  title: string
  description: string | null
  notes: string | null
  priority: 'alta' | 'media' | 'baixa'
  deadline: string | null
  status: 'pendente' | 'em_andamento' | 'concluida'
  category: 'trabalho' | 'pessoal'
  client_id: string | null
  created_at: string
}
