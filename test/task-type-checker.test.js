import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTaskType, assessCompleteness } from "../task-type-checker.js";

const SAMPLE_TASK_TYPES = [
  {
    id: "pipeline",
    label: "データパイプライン構築",
    keywords: ["pipeline", "パイプライン", "ETL", "データ連携", "S3", "Glue", "BigQuery"],
    checklist: [
      { item: "データソースの指定", output: "tech_checklist.md" },
      { item: "全件/差分の連携方式", output: "decisions.md" },
      { item: "エラー時の挙動", output: "decisions.md" },
    ],
  },
  {
    id: "bugfix",
    label: "バグ修正",
    keywords: ["bug", "バグ", "fix", "修正", "不具合", "エラー"],
    checklist: [
      { item: "再現手順", output: "tech_checklist.md" },
      { item: "期待する動作", output: "decisions.md" },
      { item: "影響範囲", output: "tech_checklist.md" },
    ],
  },
  {
    id: "refactor",
    label: "リファクタリング",
    keywords: ["refactor", "リファクタ", "技術負債", "debt"],
    checklist: [
      { item: "対象モジュール/ファイル", output: "tech_checklist.md" },
      { item: "変更の動機", output: "decisions.md" },
      { item: "互換性への影響", output: "decisions.md" },
    ],
  },
  {
    id: "feature",
    label: "新機能開発",
    keywords: ["feature", "機能", "追加", "新規"],
    checklist: [
      { item: "ユーザーストーリー", output: "decisions.md" },
      { item: "受入条件", output: "tech_checklist.md" },
      { item: "画面/API仕様", output: "tech_checklist.md" },
      { item: "非機能要件", output: "tech_checklist.md" },
    ],
  },
];

describe("classifyTaskType", () => {
  it("classifies pipeline PRD", () => {
    const content = "S3からデータを取得するETLパイプラインを構築する。BigQueryに連携。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "pipeline");
    assert.equal(result.label, "データパイプライン構築");
    assert.ok(result.score >= 3);
  });

  it("classifies bugfix PRD", () => {
    const content = "ログイン画面で不具合が発生。バグの修正が必要。エラーメッセージを確認。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "bugfix");
  });

  it("classifies feature PRD", () => {
    const content = "新規機能を追加する。ダッシュボードにfeatureフラグを実装。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "feature");
  });

  it("classifies refactor PRD", () => {
    const content = "技術負債を解消するためにリファクタリングを行う。debtを減らす。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "refactor");
  });

  it("returns unknown for no matches", () => {
    const content = "何もマッチしない内容です。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "unknown");
    assert.equal(result.score, 0);
    assert.deepEqual(result.checklist, []);
  });

  it("returns unknown for empty content", () => {
    const result = classifyTaskType("", SAMPLE_TASK_TYPES);
    assert.equal(result.id, "unknown");
  });

  it("returns unknown for null/undefined content", () => {
    assert.equal(classifyTaskType(null, SAMPLE_TASK_TYPES).id, "unknown");
    assert.equal(classifyTaskType(undefined, SAMPLE_TASK_TYPES).id, "unknown");
  });

  it("returns unknown for empty task types", () => {
    assert.equal(classifyTaskType("some content", []).id, "unknown");
    assert.equal(classifyTaskType("some content", null).id, "unknown");
  });

  it("is case-insensitive", () => {
    const content = "Building a PIPELINE with ETL process";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "pipeline");
  });

  it("picks the type with more keyword matches", () => {
    // "修正" matches bugfix, "エラー" matches both bugfix and pipeline
    // but "バグ" and "不具合" also match bugfix => bugfix wins
    const content = "バグの修正。不具合でエラーが出る。修正手順を確認。";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.id, "bugfix");
  });

  it("includes checklist in result", () => {
    const content = "pipeline ETL S3";
    const result = classifyTaskType(content, SAMPLE_TASK_TYPES);
    assert.equal(result.checklist.length, 3);
    assert.equal(result.checklist[0].item, "データソースの指定");
  });
});

describe("assessCompleteness", () => {
  it("finds all items when content covers everything", () => {
    const content = "データソースの指定: S3バケット\n全件/差分の連携方式: 差分\nエラー時の挙動: リトライ";
    const checklist = SAMPLE_TASK_TYPES[0].checklist;
    const result = assessCompleteness(content, checklist);
    assert.equal(result.total, 3);
    assert.equal(result.satisfied, 3);
    assert.equal(result.percentage, 100);
    assert.ok(result.items.every(i => i.found));
  });

  it("reports missing items", () => {
    const content = "データソースの指定: S3";
    const checklist = SAMPLE_TASK_TYPES[0].checklist;
    const result = assessCompleteness(content, checklist);
    assert.equal(result.total, 3);
    assert.equal(result.satisfied, 1);
    assert.ok(result.items[0].found);
    assert.ok(!result.items[1].found);
    assert.ok(!result.items[2].found);
  });

  it("handles empty content", () => {
    const checklist = SAMPLE_TASK_TYPES[0].checklist;
    const result = assessCompleteness("", checklist);
    assert.equal(result.satisfied, 0);
    assert.equal(result.percentage, 0);
  });

  it("handles null content", () => {
    const checklist = SAMPLE_TASK_TYPES[0].checklist;
    const result = assessCompleteness(null, checklist);
    assert.equal(result.satisfied, 0);
  });

  it("handles empty checklist", () => {
    const result = assessCompleteness("some content", []);
    assert.equal(result.total, 0);
    assert.equal(result.percentage, 0);
  });

  it("handles null checklist", () => {
    const result = assessCompleteness("some content", null);
    assert.equal(result.total, 0);
  });

  it("calculates percentage correctly", () => {
    const content = "ユーザーストーリー: US-1\n受入条件: 完了";
    const checklist = SAMPLE_TASK_TYPES[3].checklist; // feature: 4 items
    const result = assessCompleteness(content, checklist);
    assert.equal(result.total, 4);
    assert.equal(result.satisfied, 2);
    assert.equal(result.percentage, 50);
  });

  it("preserves output field in results", () => {
    const content = "再現手順: ログインページを開く";
    const checklist = SAMPLE_TASK_TYPES[1].checklist;
    const result = assessCompleteness(content, checklist);
    assert.equal(result.items[0].output, "tech_checklist.md");
    assert.equal(result.items[1].output, "decisions.md");
  });

  it("does partial token matching via slash-split", () => {
    // "対象モジュール/ファイル" splits into ["対象モジュール", "ファイル"]
    // Content contains "対象モジュール" -> 1/2 tokens match -> found
    const content = "対象モジュールを特定する";
    const checklist = [{ item: "対象モジュール/ファイル", output: "tech_checklist.md" }];
    const result = assessCompleteness(content, checklist);
    assert.ok(result.items[0].found);
  });

  it("does not match when no tokens are found", () => {
    const content = "何も関係ない内容";
    const checklist = [{ item: "対象モジュール/ファイル", output: "tech_checklist.md" }];
    const result = assessCompleteness(content, checklist);
    assert.ok(!result.items[0].found);
  });
});
