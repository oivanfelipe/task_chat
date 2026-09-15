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
  callSummaries: Array<{ doc_name: string; summary: string; participants: string | null; meeting_date: string | null }>,
  clientInsights: Array<{ client_id: string; doc_name: string; meeting_date: string | null; key_decisions: string[]; open_items: string[]; context: string | null }>
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

  // Group insights by client for compact injection
  const insightsByClient: Record<string, typeof clientInsights> = {}
  for (const ins of clientInsights) {
    if (!insightsByClient[ins.client_id]) insightsByClient[ins.client_id] = []
    insightsByClient[ins.client_id].push(ins)
  }
  const insightLines = Object.entries(insightsByClient)
    .flatMap(([, insights]) =>
      insights.slice(0, 3).map(ins => {
        const decisions = ins.key_decisions.length ? `Decisões: ${ins.key_decisions.join('; ')}` : ''
        const items = ins.open_items.length ? `Pendentes: ${ins.open_items.join('; ')}` : ''
        return `[${ins.doc_name}${ins.meeting_date ? ` ${ins.meeting_date}` : ''}] ${ins.context || ''} ${decisions} ${items}`.trim()
      })
    )
    .join('\n')

  return `Você é um assistente de gestão de tarefas e reuniões para Ivan Felipe (marketing de performance — SEO, tráfego pago, funis, ads).
Hoje é ${todayBR} (ISO: ${todayISO}).

CARTEIRA DE CLIENTES ATIVOS:
${clientList}

${recentCalls ? `CALLS RECENTES:\n${recentCalls}\n\n` : ''}${insightLines ? `INSIGHTS DE REUNIÃO POR CLIENTE (use para responder perguntas sobre calls):\n${insightLines}\n\n` : ''}AÇÕES DISPONÍVEIS — responda APENAS com JSON quando o usuário pedir uma dessas ações (sem texto extra, sem markdown):

1. CRIAR TAREFA:
{"action":"create_task","title":"[NomeCliente] Ação objetiva","description":"Detalhes relevantes","priority":"alta|media|baixa","deadline":"YYYY-MM-DD ou null","category":"trabalho|pessoal","client_name":"NomeCliente ou null"}

2. CRIAR PAUTA NA DAILY:
{"action":"create_daily_item","text":"Texto da pauta","date":"YYYY-MM-DD","client_name":"NomeCliente ou null"}

REGRAS:
- create_task: quando o usuário mencionar uma tarefa, to-do, ação, entregável. title sempre "[NomeCliente] ação" para trabalho
- create_daily_item: quando mencionar pauta, agenda, daily, reunião de amanhã/hoje, colocar na lista
- client_name: use EXATAMENTE o nome da lista de clientes acima, ou null
- priority: "alta" (urgente/prazo curto), "media" (importante sem urgência), "baixa" (backlog)
- deadline: "hoje" = ${todayISO}, "amanhã" = ${tomorrowISO}
- Crie IMEDIATAMENTE em uma só resposta (ZERO perguntas de acompanhamento)

Fora do fluxo de ações (perguntas sobre calls, clientes, situação geral): responda normalmente em português, de forma direta e objetiva, usando os INSIGHTS DE REUNIÃO disponíveis.`
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

    const [clientsRes, callsRes, insightsRes] = await Promise.all([
      supabase.from('clients').select('id, name, segment, services, status').order('name'),
      supabase.from('call_summaries').select('doc_name, summary, participants, meeting_date').order('created_at', { ascending: false }).limit(5),
      supabase.from('client_meeting_insights').select('client_id, doc_name, meeting_date, key_decisions, open_items, context').order('created_at', { ascending: false }).limit(30),
    ])

    const clients = clientsRes.data || []
    const callSummaries = callsRes.data || []
    const clientInsights = insightsRes.data || []

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: getSystemPrompt(clients, callSummaries, clientInsights) },
        ...history,
        { role: 'user', content: userMessage },
      ],
    })

    let responseText = completion.choices[0].message.content || ''

    let task = null
    let dailyItem = null

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*"action"\s*:\s*"(create_task|create_daily_item)"[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])

        if (parsed.action === 'create_task') {
          parsed.client_id = resolveClientId(parsed.client_name ?? null, clients)
          task = parsed
          responseText = `✅ Tarefa "${task.title}" criada!`
        } else if (parsed.action === 'create_daily_item') {
          const clientId = resolveClientId(parsed.client_name ?? null, clients)
          const { data: inserted } = await supabase
            .from('daily_items')
            .insert({ date: parsed.date, text: parsed.text, client_id: clientId })
            .select()
            .single()
          dailyItem = inserted
          responseText = `📋 Pauta "${parsed.text}" adicionada à daily de ${parsed.date}!`
        }
      }
    } catch { /* normal response */ }

    return NextResponse.json({
      message: responseText,
      transcription: audio && audio.size > 0 ? userMessage : null,
      task,
      daily_item: dailyItem,
    })
  } catch (err) {
    console.error('Erro na API de chat:', err)
    return NextResponse.json({ error: 'Erro interno. Tente novamente.' }, { status: 500 })
  }
}
