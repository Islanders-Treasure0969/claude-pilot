/**
 * Task Type Checker — PRD task classification and completeness assessment
 *
 * Classifies PRD content by task type (pipeline, bugfix, refactor, feature, etc.)
 * and evaluates completeness against type-specific checklists.
 */

/**
 * Classify the task type of a PRD by counting keyword matches.
 *
 * @param {string} prdContent - The raw text of the PRD document
 * @param {Array<{id:string, label:string, keywords:string[], checklist:Array}>} taskTypes
 * @returns {{id:string, label:string, score:number, checklist:Array} | {id:"unknown", label:"Unknown", score:0, checklist:[]}}
 */
export function classifyTaskType(prdContent, taskTypes) {
  if (!prdContent || !taskTypes || taskTypes.length === 0) {
    return { id: "unknown", label: "Unknown", score: 0, checklist: [] };
  }

  const lowerContent = prdContent.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const taskType of taskTypes) {
    const keywords = taskType.keywords || [];
    let score = 0;
    for (const keyword of keywords) {
      // Case-insensitive string includes
      if (lowerContent.includes(keyword.toLowerCase())) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = taskType;
    }
  }

  if (!bestMatch || bestScore === 0) {
    return { id: "unknown", label: "Unknown", score: 0, checklist: [] };
  }

  return {
    id: bestMatch.id,
    label: bestMatch.label,
    score: bestScore,
    checklist: bestMatch.checklist || [],
  };
}

/**
 * Assess completeness of a PRD against a checklist.
 * Each checklist item is checked by looking for its item text (or close variants)
 * in the PRD content via case-insensitive string includes.
 *
 * @param {string} prdContent - The raw text of the PRD document
 * @param {Array<{item:string, output:string}>} checklist
 * @returns {{total:number, satisfied:number, percentage:number, items:Array<{item:string, output:string, found:boolean}>}}
 */
export function assessCompleteness(prdContent, checklist) {
  if (!checklist || checklist.length === 0) {
    return { total: 0, satisfied: 0, percentage: 0, items: [] };
  }

  const lowerContent = (prdContent || "").toLowerCase();
  const items = [];
  let satisfied = 0;

  for (const entry of checklist) {
    const itemText = (entry.item || "").toLowerCase();
    // Split the item text into meaningful tokens (2+ chars) for flexible matching.
    // Split on whitespace, slashes, dots, commas, and common Japanese punctuation.
    const tokens = itemText.split(/[\s/・、。,.]+/).filter(t => t.length >= 2);
    // Found if the full item string appears, or if at least half of the
    // meaningful tokens appear individually in the content.
    const fullMatch = lowerContent.includes(itemText);
    const tokenMatches = tokens.filter(t => lowerContent.includes(t)).length;
    const found = fullMatch || (tokens.length > 0 && tokenMatches >= Math.ceil(tokens.length / 2));

    items.push({
      item: entry.item,
      output: entry.output,
      found,
    });
    if (found) satisfied++;
  }

  const total = checklist.length;
  const percentage = total > 0 ? Math.round((satisfied / total) * 100) : 0;

  return { total, satisfied, percentage, items };
}
