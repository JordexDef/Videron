import {tr} from './i18n.js'
import {taskMarker} from './note-lists.js'

// The marker is separate from the content so text diffs and anchors still
// refer to the note's own characters.
export function taskTextContainer(row, state, markerClass) {
  if (!state) return row
  const marker = document.createElement('span')
  marker.textContent = taskMarker(state)
  marker.setAttribute('role', 'img')
  const label = state === 'done' ? tr('Задача выполнена', 'Completed task')
    : state === 'cancelled' ? tr('Задача отменена', 'Cancelled task')
    : tr('Открытая задача', 'Open task')
  marker.setAttribute('aria-label', label)
  marker.title = label
  if (markerClass) marker.className = markerClass
  const content = document.createElement(state === 'pending' ? 'span' : 's')
  row.append(marker, ' ', content)
  return content
}
