import Groq from 'groq-sdk'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

function normalizeStr(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

function resolveClientId(name: string | null, clients: Array<{ id: string; name: string }>) {
  if (!name) return null
  const norm = normalizeStr(name)
  const exact = clients.find(c => normalizeStr(c.name) === norm)
  if (exact) return exact.id
  const contains = clients.find(c => normalizeStr(c.name).includes(norm) || norm.includes(normalizeStr(c.name)))
  return contains?.id ?? null
}

function getSystemPrompt(
  clients: Array<{ name: string; segment: string | null; services: string[]; status: string }>,
  callSummaries: Array<{ doc_name: string; summary: string; participants: string | null; meeting_date: string | null }>
) {
  const today = new Date()
  const todayISO = today.toISOString().split('T')[0]
  const tomorrowISO = new Date(Date.now() + 86400000).toISOString().split('T')[0]
  const todayBR = today.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })

  const clientList = clients
    .filter(c => c.status === 'active')
    .map(c => {
      const srv = c.services?.length ? ` (${c.services.join(', ')})` : ''
      const seg = c.segment ? ` [${c.segment}]` : ''
      return `- ${c.name}${seg}${srv}`
    })
    .join('\n')

  const recentCalls = callSummaries
    .slice(0, 5)
    .map(cs =>
      `- ${cs.doc_name}${cs.meeting_date ? ` (${cs.meeting_date})` : ''}: ${cs.summary}${cs.participants ? ` | Participantes: ${cs.participants}` : ''}`
    )
    .join('\n')

  return `Você é um assistente de gestão de tarefas para Ivan Felipe (marketing de performance — SEO, tráfego pago, funis, ads).
Hoje é ${todayBR} (ISO: ${todayISO}).

CARTEIRA DE CLIENTES ATIVOS:
${clientList}

${recentCalls ? `CALLS RECENTES:\n${recentCalls}\n\n` : ''}CRIAÇÃO DE TAREFA — regras obrigatórias:
- Ao receber uma tarefa, crie IMEDIATAMENTE em uma só resposta (ZERO perguntas de acompanhamento)
- Infira cliente, prioridade e prazo pelo contexto. Se não houver cliente claro, use null
- Responda APENAS com JSON (sem texto extra, sem markdown):

{"action":"create_task","title":"[NomeCliente] Ação objetiva","description":"Detalhes relevantes","priority":"alta|media|baixa","deadline":"YYYY-MM-DD ou null","category":"trabalho|pessoal","client_name":"NomeCliente ou null"}

REGRAS:
- title: para trabalho com cliente, sempre "[NomeCliente] ação"
- client_name: use EXATAMENTE o nome da lista de clientes acima, ou null se pessoal/sem cliente
- priority: "alta" (urgente/prazo curto), "media" (importante sem urgência), "baixa" (backlog)
- deadline: "hoje" = ${todayISO}, "amanhã" = ${tomorrowISO}, interprete semanas/meses relativos corretamente
- category: "trabalho" para clientes/marketing, "pessoal" para saúde/família/lazer

Fora do fluxo de tarefas (perguntas sobre calls, clientes, situação geral): responda normalmente em português, de forma direta e objetiva.`
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const text = formData.get('text') as string | null
    const audio = formData.get('audio') as File | null
    const historyRaw = formData.get('history') as string

    const history: Array<{ role: 'user' | 'assistant'; content: string }> =
      historyRaw ? JSON.parse(historyRaw) : []

    let userMessage = text?.trim() || ''

    if (audio && audio.size > 0) {
      const transcription = await groq.audio.transcriptions.create({
        file: audio,
        model: 'whisper-large-v3',
        language: 'pt',
        response_format: 'text',
      })
      userMessage = (transcription as unknown as string).trim()
    }

    if (!userMessage) {
      return NextResponse.json({ error: 'Nenhuma mensagem recebida' }, { status: 400 })
    }

    const [clientsRes, callsRes] = await Promise.all([
      supabase.from('clients').select('id, name, segment, services, status').order('name'),
      supabase.from('call_summaries').select('doc_name, summary, participants, meeting_date').order('created_at', { ascending: false }).limit(5),
    ])

    const clients = clientsRes.data || []
    const callSummaries = callsRes.data || []

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: getSystemPrompt(clients, callSummaries) },
        ...history,
        { role: 'user', content: userMessage },
      ],
    })

    let responseText = completion.choices[0].message.content || ''

    let task = null
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*"action"\s*:\s*"create_task"[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        parsed.client_id = resolveClientId(parsed.client_name ?? null, clients)
        task = parsed
        responseText = `✅ Tarefa "${task.title}" criada!`
      }
    } catch { /* normal response */ }

    return NextResponse.json({
      message: responseText,
      transcription: audio && audio.size > 0 ? userMessage : null,
      task,
    })
  } catch (err) {
    console.error('Erro na API de chat:', err)
    return NextResponse.json({ error: 'Erro interno. Tente novamente.' }, { status: 500 })
  }
}
