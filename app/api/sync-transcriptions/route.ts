import Groq from 'groq-sdk'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID!
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY!

const USER_PROFILE = `Ivan Felipe — profissional de marketing de performance (SEO, tráfego pago, funis, ads).
Tarefas de TRABALHO: campanhas, clientes, ads (Meta/Google/TikTok/LinkedIn), SEO, relatórios, reuniões, ferramentas de marketing, CRO, funil.
Tarefas PESSOAIS: domésticas, saúde, família, lazer.`

function normalizeStr(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

function resolveClientId(title: string, clients: Array<{ id: string; name: string }>) {
  const bracketMatch = title.match(/^\[([^\]]+)\]/)
  if (!bracketMatch) return null
  const name = bracketMatch[1]
  const norm = normalizeStr(name)
  const exact = clients.find(c => normalizeStr(c.name) === norm)
  if (exact) return exact.id
  const contains = clients.find(c => normalizeStr(c.name).includes(norm) || norm.includes(normalizeStr(c.name)))
  return contains?.id ?? null
}

function toRFC3339(ts: string): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function getLastSyncAt(): Promise<string> {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'last_sync_at')
    .single()
  return data?.value || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

async function updateLastSyncAt(ts: string) {
  await supabase.from('settings').upsert({
    key: 'last_sync_at',
    value: ts,
    updated_at: new Date().toISOString(),
  })
}

async function listDocs(since: string) {
  const sinceRFC = toRFC3339(since)
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', `'${FOLDER_ID}' in parents and trashed=false and modifiedTime >= '${sinceRFC}'`)
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)')
  url.searchParams.set('orderBy', 'modifiedTime desc')

  const res = await fetch(url.toString())
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Drive API error: ${res.status} ${body}`)
  }
  const data = await res.json()
  return (data.files || []) as Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>
}

async function listAllDocs() {
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', `'${FOLDER_ID}' in parents and trashed=false`)
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)')
  url.searchParams.set('orderBy', 'modifiedTime desc')
  url.searchParams.set('pageSize', '100')

  const res = await fetch(url.toString())
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Drive API error: ${res.status} ${body}`)
  }
  const data = await res.json()
  return (data.files || []) as Array<{ id: string; name: string; mimeType: string; modifiedTime: string }>
}

async function exportDocAsText(fileId: string): Promise<string> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/export`)
  url.searchParams.set('mimeType', 'text/plain')
  url.searchParams.set('key', GOOGLE_API_KEY)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Export error: ${res.status}`)
  return res.text()
}

async function extractTasks(text: string, docName: string) {
  const todayISO = new Date().toISOString().split('T')[0]

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    max_tokens: 3000,
    messages: [
      {
        role: 'system',
        content: `Você extrai tarefas acionáveis de transcrições de reuniões para Ivan Felipe.
Perfil de Ivan: ${USER_PROFILE}
Hoje: ${todayISO}

REGRA PRINCIPAL — Só crie tarefa para Ivan Felipe quando:
1. Ele próprio assumiu a responsabilidade: "eu vou fazer", "vou analisar", "fico responsável", "vou verificar", "deixa comigo", "eu cuido", "vou resolver", "vou enviar", "vou criar", "vou ajustar"
2. Ele explicitamente disse que vai cobrar, acompanhar ou lembrar: "vou cobrar", "preciso lembrar disso", "vou acompanhar", "vou checar depois", "preciso verificar se fizeram"

IGNORE completamente quando Ivan está delegando para outras pessoas — a menos que ele também diga que vai cobrar/acompanhar.

FORMATO de cada tarefa:
- "title": curto e objetivo, SEMPRE inclua o cliente/empresa identificado. Ex: "[NomeCliente] Analisar campanha de remarketing"
- "description": contexto do que precisa ser feito
- "priority": "alta" (urgente/prazo curto), "media" (importante), "baixa" (backlog)
- "deadline": "YYYY-MM-DD" se mencionado, null se não
- "category": "trabalho" ou "pessoal"

Retorne APENAS um JSON array (sem markdown, sem texto adicional):
[{"title":"...","description":"...","priority":"alta|media|baixa","deadline":"YYYY-MM-DD ou null","category":"trabalho|pessoal"}]

Se não houver tarefas de Ivan Felipe, retorne: []`,
      },
      {
        role: 'user',
        content: `Nome do documento: "${docName}"\n\nTranscrição:\n${text.slice(0, 10000)}`,
      },
    ],
  })

  const content = completion.choices[0].message.content || '[]'
  try {
    const match = content.match(/\[[\s\S]*\]/)
    return match ? JSON.parse(match[0]) : []
  } catch {
    console.error('Tasks JSON parse error:', content.slice(0, 200))
    return []
  }
}

async function extractCallSummary(text: string, docName: string) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content: `Você gera resumos estruturados de transcrições de reuniões para Ivan Felipe (marketing de performance).
Retorne APENAS um JSON (sem markdown, sem texto adicional):
{"summary":"2-3 frases resumindo o objetivo e resultado da reunião","participants":"nomes dos participantes separados por vírgula, ou null","key_points":["ponto-chave 1","ponto-chave 2","ponto-chave 3"],"meeting_date":"YYYY-MM-DD ou null","action_items_count":0}`,
      },
      {
        role: 'user',
        content: `Nome do documento: "${docName}"\n\nTranscrição:\n${text.slice(0, 8000)}`,
      },
    ],
  })

  const content = completion.choices[0].message.content || '{}'
  try {
    const match = content.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : null
  } catch {
    console.error('Summary JSON parse error:', content.slice(0, 200))
    return null
  }
}

export async function POST() {
  try {
    if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'cole_sua_chave_aqui') {
      return NextResponse.json({ error: 'GOOGLE_API_KEY não configurada' }, { status: 400 })
    }

    const syncStartedAt = new Date().toISOString()
    const lastSyncAt = await getLastSyncAt()

    // Recent docs (for task extraction — only new/modified since last sync)
    const recentFiles = await listDocs(lastSyncAt)
    const recentDocs = recentFiles.filter(f => f.mimeType === 'application/vnd.google-apps.document')

    // All docs in folder (for summary generation — catches old docs never summarized)
    const allFiles = await listAllDocs()
    const allDocs = allFiles.filter(f => f.mimeType === 'application/vnd.google-apps.document')

    // Docs already processed for task extraction
    const { data: processed } = await supabase.from('processed_docs').select('doc_id')
    const processedIds = new Set((processed || []).map((p: { doc_id: string }) => p.doc_id))

    // Docs that already have a call summary
    const { data: existingSummaries } = await supabase.from('call_summaries').select('doc_id')
    const summaryIds = new Set((existingSummaries || []).map((s: { doc_id: string }) => s.doc_id))

    // Docs needing task extraction (recently modified, not yet processed)
    const docsForTasks = recentDocs.filter(f => !processedIds.has(f.id))

    // Docs needing summary generation (any doc in folder without a summary)
    const docsForSummary = allDocs.filter(f => !summaryIds.has(f.id))

    if (docsForTasks.length === 0 && docsForSummary.length === 0) {
      await updateLastSyncAt(syncStartedAt)
      const sinceBR = new Date(lastSyncAt).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      return NextResponse.json({
        message: `Tudo sincronizado. Nenhuma novidade desde ${sinceBR}.`,
        synced: 0,
        tasks_created: 0,
        summaries_created: 0,
      })
    }

    // Load clients for client_id resolution
    const { data: clientsData } = await supabase.from('clients').select('id, name')
    const clients = clientsData || []

    let totalTasks = 0
    let totalSummaries = 0
    const results: Array<{ doc: string; tasks: number }> = []

    // Process docs needing full extraction (tasks + summary)
    for (const doc of docsForTasks) {
      try {
        const text = await exportDocAsText(doc.id)
        if (!text.trim()) {
          await supabase.from('processed_docs').insert({
            doc_id: doc.id, doc_name: doc.name, tasks_extracted: 0,
          })
          summaryIds.add(doc.id) // mark so we don't re-process below
          continue
        }

        const [tasks, callSummary] = await Promise.all([
          extractTasks(text, doc.name),
          extractCallSummary(text, doc.name),
        ])

        if (tasks.length > 0) {
          await supabase.from('tasks').insert(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tasks.map((t: any) => ({
              title: t.title,
              description: t.description || null,
              priority: ['alta', 'media', 'baixa'].includes(t.priority) ? t.priority : 'media',
              deadline: t.deadline || null,
              category: t.category === 'pessoal' ? 'pessoal' : 'trabalho',
              status: 'pendente',
              client_id: resolveClientId(t.title, clients),
            }))
          )
          totalTasks += tasks.length
        }

        if (callSummary) {
          await supabase.from('call_summaries').upsert({
            doc_id: doc.id,
            doc_name: doc.name,
            summary: callSummary.summary || '',
            participants: callSummary.participants || null,
            key_points: callSummary.key_points || [],
            meeting_date: callSummary.meeting_date || null,
            action_items_count: tasks.length,
          }, { onConflict: 'doc_id' })
          totalSummaries++
          summaryIds.add(doc.id)
        }

        await supabase.from('processed_docs').insert({
          doc_id: doc.id, doc_name: doc.name, tasks_extracted: tasks.length,
        })
        results.push({ doc: doc.name, tasks: tasks.length })
      } catch (err) {
        console.error(`Erro ao processar "${doc.name}":`, err)
      }
    }

    // Generate summaries for docs not yet summarized (old docs, no task extraction needed)
    for (const doc of docsForSummary) {
      if (summaryIds.has(doc.id)) continue // already handled above
      try {
        const text = await exportDocAsText(doc.id)
        if (!text.trim()) continue

        const callSummary = await extractCallSummary(text, doc.name)
        if (callSummary) {
          await supabase.from('call_summaries').upsert({
            doc_id: doc.id,
            doc_name: doc.name,
            summary: callSummary.summary || '',
            participants: callSummary.participants || null,
            key_points: callSummary.key_points || [],
            meeting_date: callSummary.meeting_date || null,
            action_items_count: 0,
          }, { onConflict: 'doc_id' })
          totalSummaries++
        }
      } catch (err) {
        console.error(`Erro ao gerar resumo de "${doc.name}":`, err)
      }
    }

    await updateLastSyncAt(syncStartedAt)

    const sinceBR = new Date(lastSyncAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })

    const parts = []
    if (totalTasks > 0) parts.push(`${docsForTasks.length} doc(s) novo(s), ${totalTasks} tarefa(s) criada(s)`)
    if (totalSummaries > 0) parts.push(`${totalSummaries} resumo(s) de call gerado(s)`)
    const message = parts.length > 0 ? parts.join(' · ') + `. (desde ${sinceBR})` : `Sincronizado. (desde ${sinceBR})`

    return NextResponse.json({
      message,
      synced: docsForTasks.length,
      tasks_created: totalTasks,
      summaries_created: totalSummaries,
      details: results,
    })
  } catch (err) {
    console.error('Erro no sync:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
