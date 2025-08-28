import { convertColumnsFromChunks } from './convertColumnsFromChunks';
import { convertColumnsObjectFromChunks } from './convertColumnsObjectFromChunks';
import { convertRowObjectsFromChunks } from './convertRowObjectsFromChunks';
import { convertRowsFromChunks } from './convertRowsFromChunks';
import { DuckDBDataChunk } from './DuckDBDataChunk';
import { DuckDBLogicalType } from './DuckDBLogicalType';
import { DuckDBResult } from './DuckDBResult';
import { DuckDBType } from './DuckDBType';
import { DuckDBTypeId } from './DuckDBTypeId';
import { DuckDBValueConverter } from './DuckDBValueConverter';
import { ResultReturnType, StatementType } from './enums';
import { getColumnsFromChunks } from './getColumnsFromChunks';
import { getColumnsObjectFromChunks } from './getColumnsObjectFromChunks';
import { getRowObjectsFromChunks } from './getRowObjectsFromChunks';
import { getRowsFromChunks } from './getRowsFromChunks';
import { JS } from './JS';
import { JSDuckDBValueConverter } from './JSDuckDBValueConverter';
import { Json } from './Json';
import { JsonDuckDBValueConverter } from './JsonDuckDBValueConverter';
import { DuckDBValue } from './values';

interface ChunkSizeRun {
  chunkCount: number;
  chunkSize: number;
  rowCount: number; // Equal to chunkCount * chunkSize; precalculated for efficiency.
}

export class DuckDBResultReader {
  private readonly result: DuckDBResult;
  private readonly chunks: DuckDBDataChunk[];
  private readonly chunkSizeRuns: ChunkSizeRun[];
  private currentRowCount_: number;
  private done_: boolean;

  constructor(result: DuckDBResult) {
    this.result = result;
    this.chunks = [];
    this.chunkSizeRuns = [];
    this.currentRowCount_ = 0;
    this.done_ = false;
  }

  public get returnType(): ResultReturnType {
    return this.result.returnType;
  }

  public get statementType(): StatementType {
    return this.result.statementType;
  }

  public get columnCount(): number {
    return this.result.columnCount;
  }

  public columnName(columnIndex: number): string {
    return this.result.columnName(columnIndex);
  }

  public columnNames(): string[] {
    return this.result.columnNames();
  }

  public deduplicatedColumnNames(): string[] {
    return this.result.deduplicatedColumnNames();
  }

  public columnTypeId(columnIndex: number): DuckDBTypeId {
    return this.result.columnTypeId(columnIndex);
  }

  public columnLogicalType(columnIndex: number): DuckDBLogicalType {
    return this.result.columnLogicalType(columnIndex);
  }

  public columnType(columnIndex: number): DuckDBType {
    return this.result.columnType(columnIndex);
  }

  public columnTypeJson(columnIndex: number): Json {
    return this.result.columnTypeJson(columnIndex);
  }

  public columnTypes(): DuckDBType[] {
    return this.result.columnTypes();
  }

  public columnTypesJson(): Json {
    return this.result.columnTypesJson();
  }

  public columnNamesAndTypesJson(): Json {
    return this.result.columnNamesAndTypesJson();
  }

  public columnNameAndTypeObjectsJson(): Json {
    return this.result.columnNameAndTypeObjectsJson();
  }

  public get rowsChanged(): number {
    return this.result.rowsChanged;
  }

  /** Total number of rows read so far. Call `readAll` or `readUntil` to read rows. */
  public get currentRowCount() {
    return this.currentRowCount_;
  }

  /** Whether reading is done, that is, there are no more rows to read. */
  public get done() {
    return this.done_;
  }

  /**
   * Returns the value for the given column and row. Both are zero-indexed.
   *
   * Will return an error if `rowIndex` is greater than `currentRowCount`.
   */
  public value(columnIndex: number, rowIndex: number): DuckDBValue {
    if (this.currentRowCount_ === 0) {
      throw Error(`No rows have been read`);
    }
    let chunkIndex = 0;
    let currentRowIndex = rowIndex;
    // Find which run of chunks our row is in.
    // Since chunkSizeRuns shouldn't ever be longer than 2, this should be O(1).
    for (const run of this.chunkSizeRuns) {
      if (currentRowIndex < run.rowCount) {
        // The row we're looking for is in this run.
        // Calculate the chunk index and the row index in that chunk.
        chunkIndex += Math.floor(currentRowIndex / run.chunkSize);
        const rowIndexInChunk = currentRowIndex % run.chunkSize;
        const chunk = this.chunks[chunkIndex];
        return chunk.getColumnVector(columnIndex).getItem(rowIndexInChunk);
      }
      // The row we're looking for is not in this run.
      // Update our counts for this run and move to the next one.
      chunkIndex += run.chunkCount;
      currentRowIndex -= run.rowCount;
    }
    // We didn't find our row. It must have been out of range.
    throw Error(
      `Row index ${rowIndex} requested, but only ${this.currentRowCount_} row have been read so far.`,
    );
  }

  /** Read all rows. */
  public async readAll(): Promise<void> {
    return this.fetchChunks();
  }

  /**
   * Read rows until at least the given target row count has been met.
   *
   * Note that the resulting row count could be greater than the target, since rows are read in chunks, typically of 2048 rows each.
   */
  public async readUntil(targetRowCount: number): Promise<void> {
    return this.fetchChunks(targetRowCount);
  }

  private async fetchChunks(targetRowCount?: number): Promise<void> {
    while (
      !(
        this.done_ ||
        (targetRowCount !== undefined &&
          this.currentRowCount_ >= targetRowCount)
      )
    ) {
      const chunk = await this.result.fetchChunk();
      if (chunk && chunk.rowCount > 0) {
        this.updateChunkSizeRuns(chunk);
        this.chunks.push(chunk);
        this.currentRowCount_ += chunk.rowCount;
      } else {
        this.done_ = true;
      }
    }
  }

  private updateChunkSizeRuns(chunk: DuckDBDataChunk) {
    if (this.chunkSizeRuns.length > 0) {
      const lastRun = this.chunkSizeRuns[this.chunkSizeRuns.length - 1];
      if (lastRun.chunkSize === chunk.rowCount) {
        // If the new batch is the same size as the last one, just update our last run.
        lastRun.chunkCount += 1;
        lastRun.rowCount += lastRun.chunkSize;
        return;
      }
    }
    // If this is our first batch, or it's a different size, create a new run.
    this.chunkSizeRuns.push({
      chunkCount: 1,
      chunkSize: chunk.rowCount,
      rowCount: chunk.rowCount,
    });
  }

  public getColumns(): DuckDBValue[][] {
    return getColumnsFromChunks(this.chunks);
  }

  public convertColumns<T>(converter: DuckDBValueConverter<T>): (T | null)[][] {
    return convertColumnsFromChunks(this.chunks, converter);
  }

  public getColumnsJS(): JS[][] {
    return this.convertColumns(JSDuckDBValueConverter);
  }

  public getColumnsJson(): Json[][] {
    return this.convertColumns(JsonDuckDBValueConverter);
  }

  public getColumnsObject(): Record<string, DuckDBValue[]> {
    return getColumnsObjectFromChunks(
      this.chunks,
      this.deduplicatedColumnNames(),
    );
  }

  public convertColumnsObject<T>(
    converter: DuckDBValueConverter<T>,
  ): Record<string, (T | null)[]> {
    return convertColumnsObjectFromChunks(
      this.chunks,
      this.deduplicatedColumnNames(),
      converter,
    );
  }

  public getColumnsObjectJS(): Record<string, JS[]> {
    return this.convertColumnsObject(JSDuckDBValueConverter);
  }

  public getColumnsObjectJson(): Record<string, Json[]> {
    return this.convertColumnsObject(JsonDuckDBValueConverter);
  }

  public getRows(): DuckDBValue[][] {
    return getRowsFromChunks(this.chunks);
  }

  public convertRows<T>(converter: DuckDBValueConverter<T>): (T | null)[][] {
    return convertRowsFromChunks(this.chunks, converter);
  }

  public getRowsJS(): JS[][] {
    return this.convertRows(JSDuckDBValueConverter);
  }

  public getRowsJson(): Json[][] {
    return this.convertRows(JsonDuckDBValueConverter);
  }

  public getRowObjects(): Record<string, DuckDBValue>[] {
    return getRowObjectsFromChunks(this.chunks, this.deduplicatedColumnNames());
  }

  public convertRowObjects<T>(
    converter: DuckDBValueConverter<T>,
  ): Record<string, T | null>[] {
    return convertRowObjectsFromChunks(
      this.chunks,
      this.deduplicatedColumnNames(),
      converter,
    );
  }

  public getRowObjectsJS(): Record<string, JS>[] {
    return this.convertRowObjects(JSDuckDBValueConverter);
  }

  public getRowObjectsJson(): Record<string, Json>[] {
    return this.convertRowObjects(JsonDuckDBValueConverter);
  }
}
