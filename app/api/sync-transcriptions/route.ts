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

function toRFC3339(ts: string): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function getLastSyncAt(): Promise<string> {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'last_sync_at')
    .single()
  // fallback: ontem
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
  // URL.searchParams garante encoding correto — sem encodeURIComponent manual
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
        content: `Você extrai tarefas acionáveis de transcrições de reuniões.
Perfil de Ivan: ${USER_PROFILE}
Hoje: ${todayISO}

REGRAS:
1. Identifique o CLIENTE ou EMPRESA sendo discutido na reunião (nome do documento ou contexto)
2. Para cada tarefa:
   - "title": curto e objetivo, SEMPRE inclua o cliente/empresa quando identificado. Ex: "[NomeCliente] Criar campanha de remarketing", "[NomeCliente] Enviar relatório semanal"
   - "description": detalhes do que precisa ser feito, contexto da reunião, responsável se mencionado, links ou referências citadas
   - "priority": "alta" (urgente/tem prazo curto), "media" (importante mas sem urgência imediata), "baixa" (backlogs/melhorias)
   - "deadline": "YYYY-MM-DD" se mencionado prazo, null se não mencionado
   - "category": "trabalho" ou "pessoal"

Retorne APENAS um JSON array (sem markdown, sem texto adicional):
[{"title":"...","description":"...","priority":"alta|media|baixa","deadline":"YYYY-MM-DD ou null","category":"trabalho|pessoal"}]

Se não houver tarefas acionáveis claras, retorne: []`,
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
    console.error('JSON parse error:', content.slice(0, 200))
    return []
  }
}

export async function POST() {
  try {
    if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'cole_sua_chave_aqui') {
      return NextResponse.json({ error: 'GOOGLE_API_KEY não configurada' }, { status: 400 })
    }

    const syncStartedAt = new Date().toISOString()
    const lastSyncAt = await getLastSyncAt()
    const files = await listDocs(lastSyncAt)
    const googleDocs = files.filter(f => f.mimeType === 'application/vnd.google-apps.document')

    // Pega IDs já processados
    const { data: processed } = await supabase.from('processed_docs').select('doc_id')
    const processedIds = new Set((processed || []).map((p: { doc_id: string }) => p.doc_id))
    const newDocs = googleDocs.filter(f => !processedIds.has(f.id))

    if (newDocs.length === 0) {
      await updateLastSyncAt(syncStartedAt)
      const sinceBR = new Date(lastSyncAt).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      return NextResponse.json({
        message: `Nenhum documento novo desde ${sinceBR}.`,
        synced: 0,
        tasks_created: 0,
      })
    }

    let totalTasks = 0
    const results: Array<{ doc: string; tasks: number }> = []

    for (const doc of newDocs) {
      try {
        const text = await exportDocAsText(doc.id)
        if (!text.trim()) {
          await supabase.from('processed_docs').insert({
            doc_id: doc.id, doc_name: doc.name, tasks_extracted: 0,
          })
          continue
        }

        const tasks = await extractTasks(text, doc.name)

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
            }))
          )
          totalTasks += tasks.length
        }

        await supabase.from('processed_docs').insert({
          doc_id: doc.id, doc_name: doc.name, tasks_extracted: tasks.length,
        })
        results.push({ doc: doc.name, tasks: tasks.length })
      } catch (err) {
        console.error(`Erro ao processar "${doc.name}":`, err)
      }
    }

    await updateLastSyncAt(syncStartedAt)

    const sinceBR = new Date(lastSyncAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })

    return NextResponse.json({
      message: `${newDocs.length} doc(s) processado(s), ${totalTasks} tarefa(s) criada(s). (desde ${sinceBR})`,
      synced: newDocs.length,
      tasks_created: totalTasks,
      details: results,
    })
  } catch (err) {
    console.error('Erro no sync:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
