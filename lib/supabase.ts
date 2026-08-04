import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export type Task = {
  id: string
  title: string
  description: string | null
  notes: string | null
  priority: 'alta' | 'media' | 'baixa'
  deadline: string | null
  status: 'pendente' | 'em_andamento' | 'concluida'
  category: 'trabalho' | 'pessoal'
  created_at: string
}
