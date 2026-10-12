import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openConversations, QUICK_DEFAULT_EFFORT, QUICK_DEFAULT_MODEL, QUICK_PROJECT_ID, type Conversation, type Project, type StoredTask } from '@shared/types'
import { draftTitle } from './agent/title'
import { readJson, writeJson } from './json-file'

/** 프로젝트·대화 목록을 userData/projects.json에 저장. 카드 순서 = 배열 순서 (숫자키 고정). */
export class ProjectStore {
  private readonly file = join(app.getPath('userData'), 'projects.json')
  private projects: Project[] = []
  /** 질문 창의 숨은 프로젝트 (userData/quick.json). list()에는 없고 get()으로만 찾는다 */
  private readonly quickFile = join(app.getPath('userData'), 'quick.json')
  private quickProject: Project

  constructor() {
    const saved = readJson(this.file)
    if (Array.isArray(saved)) this.projects = saved as Project[]
    const path = join(app.getPath('userData'), 'quick')
    mkdirSync(path, { recursive: true })
    const q = readJson(this.quickFile) as Project | null
    this.quickProject =
      q && Array.isArray(q.conversations) && q.conversations.length
        ? { ...q, id: QUICK_PROJECT_ID, path }
        : {
            id: QUICK_PROJECT_ID,
            name: 'ASK',
            path,
            conversations: [{ id: randomUUID(), title: 'ASK', titleSource: 'custom', mode: 'default', modelChoice: QUICK_DEFAULT_MODEL, effort: QUICK_DEFAULT_EFFORT }],
          }
  }

  list(): Project[] {
    return structuredClone(this.projects)
  }

  quick(): Project {
    return structuredClone(this.quickProject)
  }

  get(projectId: string): Project | undefined {
    if (projectId === QUICK_PROJECT_ID) return this.quickProject
    return this.projects.find((p) => p.id === projectId)
  }

  getConversation(projectId: string, conversationId: string): Conversation | undefined {
    return this.get(projectId)?.conversations.find((c) => c.id === conversationId)
  }

  addProject(path: string): Project {
    const project: Project = {
      id: randomUUID(),
      name: basename(path) || path,
      path,
      conversations: [newConversation(1)],
    }
    this.projects.push(project)
    this.save()
    return project
  }

  removeProject(projectId: string): void {
    this.projects = this.projects.filter((p) => p.id !== projectId)
    this.save()
  }

  addConversation(projectId: string, extra: Partial<Conversation> = {}, id?: string): Conversation {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const conv = { ...newConversation(openConversations(project).length + 1), ...extra, ...(id ? { id } : {}) }
    project.conversations.push(conv)
    this.save()
    return conv
  }

  /**
   * 대화를 닫고 옮겨 갈 대화 ID를 돌려준다 (보이는 대화 중 바로 다음 것, 없으면 앞의 것).
   * 보관하지 않은 보고서가 있으면 지우지 않고 닫힘으로만 표시해 보고함에 남긴다. 보이는 대화가 없어지면 빈 대화를 만든다
   */
  closeConversation(projectId: string, conversationId: string): string {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const open = openConversations(project)
    const i = open.findIndex((c) => c.id === conversationId)
    const conv = open[i]
    if (conv?.lastTask && !conv.lastTask.archived) conv.closedAt = Date.now()
    else project.conversations = project.conversations.filter((c) => c.id !== conversationId)
    const rest = openConversations(project)
    if (rest.length === 0) {
      const fresh = newConversation(project.conversations.length + 1)
      project.conversations.push(fresh)
      rest.push(fresh)
    }
    this.save()
    return (rest[i] ?? rest[i - 1] ?? rest[0]).id
  }

  reopenConversation(projectId: string, conversationId: string): void {
    const conv = this.getConversation(projectId, conversationId)
    if (!conv?.closedAt) return
    delete conv.closedAt
    this.save()
  }

  /** 보고서 저장. 닫힌 대화의 보고서가 보관되면 그 대화는 더 둘 이유가 없어 지운다. 지웠으면 true */
  saveTask(projectId: string, conversationId: string, task: StoredTask): boolean {
    const project = this.get(projectId)
    const conv = project?.conversations.find((c) => c.id === conversationId)
    if (!project || !conv) return false
    if (conv.closedAt && task.archived) {
      project.conversations = project.conversations.filter((c) => c.id !== conversationId)
      this.save()
      return true
    }
    conv.lastTask = task
    this.save()
    return false
  }

  /** 작업 하나 = 대화 하나. 한 번도 보내지 않은 대화(isFresh)가 있으면 재사용하고 제목을 작업 문장으로 바꾼다 */
  conversationForTask(projectId: string, text: string, isFresh: (conv: Conversation) => boolean): Conversation {
    const project = this.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const reusable = openConversations(project).find((c) => !c.sessionId && !c.lastTask && isFresh(c))
    const conv = reusable ?? newConversation(project.conversations.length + 1)
    if (!reusable) project.conversations.push(conv)
    conv.title = draftTitle(text)
    conv.titleSource = 'draft'
    this.save()
    return conv
  }

  updateConversation(projectId: string, conversationId: string, patch: Partial<Conversation>): void {
    const conv = this.getConversation(projectId, conversationId)
    if (!conv) return
    Object.assign(conv, patch)
    this.save()
  }

  private save(): void {
    writeJson(this.file, this.projects)
    writeJson(this.quickFile, this.quickProject)
  }
}

export function newConversationId(): string {
  return randomUUID()
}

function newConversation(n: number): Conversation {
  return { id: randomUUID(), title: `대화 ${n}`, mode: 'auto' }
}
