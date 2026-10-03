import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export type TaskStatus = 'todo' | 'in-progress' | 'done';
export type TaskEffort = 'S' | 'M' | 'L';
export type ModelProfile = 'fast' | 'balanced' | 'deep';
export type Task = { path: string; id: string; title: string; status: TaskStatus; priority?: string; assignee?: string; effort?: TaskEffort; model_profile?: ModelProfile; check?: string; start_date?: string; end_date?: string; depends_on: string[]; version: string };
export function isTaskStatus(value: unknown): value is TaskStatus { return value === 'todo' || value === 'in-progress' || value === 'done'; }
export function parseTask(content: string, path: string, version: string): { task: Task | null; statusRange?: [number, number]; quote?: string } {
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(content);
  if (!opening) return { task: null };
  const offset = opening[0].length;
  const rest = content.slice(offset);
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(rest);
  if (!closing) throw new Error('Frontmatter has no closing delimiter.');
  const document = parseDocument(rest.slice(0, closing.index), { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid YAML or duplicate frontmatter keys.');
  if (!isMap(document.contents)) throw new Error('Frontmatter must be a mapping.');
  const schema = document.get('schema', true);
  if (!isScalar(schema) || schema.value !== 'olav.tasks/v1') return { task: null };
  const string = (key: string) => {
    const node = document.get(key, true);
    if (!isScalar(node) || typeof node.value !== 'string' || !node.value.trim()) throw new Error(`${key} must be nonempty text.`);
    return node.value;
  };
  const id = string('id'); const title = string('title'); const status = string('status');
  if (!isTaskStatus(status)) throw new Error('status must be todo, in-progress, or done.');
  const priority = document.has('priority') ? string('priority') : undefined;
  if (priority !== undefined && !['P0', 'P1', 'P2'].includes(priority)) throw new Error('priority must be P0, P1, or P2.');
  const assignee = document.has('assignee') ? string('assignee') : undefined;
  if (assignee !== undefined && !/^(human|agent):[^\s:]+$/u.test(assignee)) throw new Error('assignee must be human:<stable ID> or agent:<stable ID>, with no whitespace or colon in the ID.');
  const effort = document.has('effort') ? string('effort') : undefined;
  if (effort !== undefined && !['S', 'M', 'L'].includes(effort)) throw new Error('effort must be S, M, or L.');
  const model_profile = document.has('model_profile') ? string('model_profile') : undefined;
  if (model_profile !== undefined && !['fast', 'balanced', 'deep'].includes(model_profile)) throw new Error('model_profile must be fast, balanced, or deep.');
  const check = document.has('check') ? string('check') : undefined;
  if (check !== undefined && (check.length > 500 || /[\r\n]/.test(check))) throw new Error('check must be a single-line command of at most 500 characters.');
  const day = (key: string) => {
    if (!document.has(key)) return undefined;
    const value = string(key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`${key} must be an actual calendar date in YYYY-MM-DD format.`);
    return value;
  };
  const start_date = day('start_date'); const end_date = day('end_date');
  if (start_date && end_date && end_date < start_date) throw new Error('end_date must be on or after start_date.');
  const dependencies = document.get('depends_on', true);
  let depends_on: string[] = [];
  if (dependencies !== undefined) {
    if (!isSeq(dependencies)) throw new Error('depends_on must be an array of task IDs.');
    depends_on = dependencies.items.map(node => {
      if (!isScalar(node) || typeof node.value !== 'string' || !node.value.trim()) throw new Error('depends_on must contain nonempty text IDs.');
      return node.value;
    });
  }
  const node = document.get('status', true);
  if (isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) throw new Error('status must use a plain or quoted scalar, not a YAML block.');
  if (!isScalar(node) || !node.range) throw new Error('status must have an editable scalar value.');
  return { task: { path, id, title, status, ...(priority ? { priority } : {}), ...(assignee ? { assignee } : {}), ...(effort ? { effort: effort as TaskEffort } : {}), ...(model_profile ? { model_profile: model_profile as ModelProfile } : {}), ...(check ? { check } : {}), ...(start_date ? { start_date } : {}), ...(end_date ? { end_date } : {}), depends_on, version }, statusRange: [offset + node.range[0], offset + node.range[1]], quote: node.type };
}
export function replaceTaskStatus(content: string, status: TaskStatus) {
  const parsed = parseTask(content, '', '');
  if (!parsed.task || !parsed.statusRange) throw new Error('File is not a valid Olav Tasks task.');
  const replacement = parsed.quote === 'QUOTE_DOUBLE' ? JSON.stringify(status) : parsed.quote === 'QUOTE_SINGLE' ? `'${status}'` : status;
  return content.slice(0, parsed.statusRange[0]) + replacement + content.slice(parsed.statusRange[1]);
}
// Set one single-line scalar field (assignee, model_profile) in the frontmatter, keeping everything else byte-for-byte.
export function setTaskField(content: string, key: 'assignee' | 'model_profile', value: string) {
  if (!parseTask(content, '', '').task) throw new Error('File is not a valid Olav Tasks task.');
  const opening = /^(?:﻿)?---\r?\n/.exec(content)!;
  const rest = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(rest)!;
  const eol = opening[0].endsWith('\r\n') ? '\r\n' : '\n';
  const front = rest.slice(0, closing.index);
  const line = new RegExp(`^${key}:[^\\r\\n]*`, 'm');
  const next = line.test(front) ? front.replace(line, `${key}: ${value}`) : `${front}${key}: ${value}${eol}`;
  const result = opening[0] + next + rest.slice(closing.index);
  if (!parseTask(result, '', '').task) throw new Error(`Invalid ${key}.`);
  return result;
}
