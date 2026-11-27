import { icon } from './art.js';
import { tr } from './i18n.js';
import { markdownExportCounts, buildMarkdownExport } from './note-export-markdown.js';
import { checkLabel, spaceDialog } from './workspace-ui.js';

let dismissCurrent = null;

export function dismissWorkspaceNoteExport() {
  dismissCurrent?.();
}

function exportError(error, fallback) {
  switch (String(error?.message || error).split('|')[0]) {
    case 'VD_EXPORT_EMPTY': return tr('В пространстве нет заметок для экспорта.', 'This workspace has no notes to export.');
    case 'VD_EXPORT_LIMIT': return tr('Экспорт превышает допустимый размер.', 'This export exceeds the size limit.');
    case 'VD_EXPORT_FORMAT': return tr('Не удалось подготовить файлы для экспорта.', 'Could not prepare files for export.');
    case 'VD_EXPORT_EXISTS': return tr('Архив с таким именем уже есть. Выберите другое имя.', 'An archive with this name already exists. Choose a different name.');
    case 'VD_EXPORT_WRITE': return tr('Не удалось записать экспорт. Проверьте доступ к папке и свободное место.', 'Could not write the export. Check folder access and available space.');
    case 'VD_EXPORT_CANCELLED': return tr('Экспорт прерван.', 'The export was interrupted.');
    default: return fallback(error);
  }
}

export function openWorkspaceNoteExport({dialog, native, workspace, folder, name, encrypted, isCurrent, onError, onExported}) {
  dismissWorkspaceNoteExport();
  const shell = title => dialog(title, true, () => { dismissCurrent = null; });
  const {box, close, error, run} = spaceDialog(shell, tr('Экспорт заметок', 'Export notes'), err => exportError(err, onError));
  dismissCurrent = close;

  const summary = document.createElement('p');
  summary.className = 'space-hint';
  const counts = markdownExportCounts(workspace());
  const lines = [tr('«{name}» · заметок для экспорта: {count}', '“{name}” · {count} notes to export', {name, count: counts.notes})];
  if (counts.skippedProtected) lines.push(tr('Заметок под отдельным паролем пропущено · {count}',
    'Individually encrypted notes skipped · {count}', {count: counts.skippedProtected}));
  if (counts.redactedCredentials) lines.push(tr('Блоков с учётными данными пропущено · {count}',
    'Credential blocks omitted · {count}', {count: counts.redactedCredentials}));
  summary.textContent = lines.join('\n');
  summary.classList.add('note-export-summary');

  const hint = document.createElement('p');
  hint.className = 'space-hint';
  hint.textContent = counts.notes
    ? tr('Markdown и ZIP сохраняются открытым текстом.', 'Markdown and ZIP exports are unencrypted.')
    : tr('В пространстве нет заметок для экспорта.', 'This workspace has no notes to export.');
  const consent = checkLabel(tr('Разрешить экспорт открытым текстом', 'Allow an unencrypted copy'));
  const actions = document.createElement('div');
  actions.className = 'note-import-sources';
  const folderButton = action('folder', 'folder', tr('Папка Markdown…', 'Markdown folder…'));
  const zipButton = action('zip', 'export', tr('ZIP-архив…', 'ZIP archive…'));
  actions.append(folderButton, zipButton);
  box.append(summary, hint);
  if (encrypted && counts.notes) box.append(consent.row);
  box.append(actions, error);
  consent.input.onchange = update;
  update();
  (encrypted && counts.notes ? consent.input : counts.notes ? folderButton : box.querySelector('button'))?.focus();

  function update() {
    folderButton.disabled = zipButton.disabled = !counts.notes || (encrypted && !consent.input.checked);
  }

  function action(kind, symbol, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    const glyph = document.createElement('i');
    glyph.innerHTML = icon(symbol);
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph, label);
    button.onclick = () => run(async report => {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (!box.isConnected || !isCurrent() || (encrypted && !consent.input.checked)) return;
      const {directories, files, summary: result} = buildMarkdownExport(workspace());
      if (!box.isConnected || !isCurrent()) return;
      if (!result.notes) throw new Error('VD_EXPORT_EMPTY');
      report(tr('Сохраняем экспорт…', 'Saving the export…'));
      const title = kind === 'folder' ? tr('Выберите папку для экспорта', 'Choose a folder for the export')
        : tr('Сохранить ZIP-архив', 'Save the ZIP archive');
      const saved = await native.WriteNoteExport(kind, title, folder, consent.input.checked, {name, directories, files});
      if (!saved || !box.isConnected || !isCurrent()) return;
      close();
      onExported(saved.folder, result);
    }, tr('Подготавливаем заметки…', 'Preparing notes…'));
    return button;
  }
}
