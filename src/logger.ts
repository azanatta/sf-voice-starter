/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free: this script runs on developer laptops and in CI, and a setup tool
 * that fails during `npm install` of its own logging library is a bad setup tool.
 */

const COLOR = process.stdout.isTTY && !process.env['NO_COLOR'];

const ESC = '\u001b';
const paint = (code: string, text: string): string =>
  COLOR ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const style = {
  dim: (t: string) => paint('2', t),
  bold: (t: string) => paint('1', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  red: (t: string) => paint('31', t),
  cyan: (t: string) => paint('36', t),
};

export class Logger {
  private phaseName = '';

  /** Announces a new phase. All subsequent lines are indented under it. */
  phase(id: string, title: string): void {
    this.phaseName = id;
    process.stdout.write(`\n${style.bold(`▸ ${id}`)} ${title}\n`);
  }

  /** A step inside the current phase. */
  step(message: string): void {
    process.stdout.write(`  ${style.dim('·')} ${message}\n`);
  }

  /** A command being executed, shown dimmed so real output stands out. */
  command(message: string): void {
    process.stdout.write(`  ${style.dim(`$ ${message}`)}\n`);
  }

  success(message: string): void {
    process.stdout.write(`  ${style.green('✔')} ${message}\n`);
  }

  /** Something was already in the desired state — the idempotency path. */
  skip(message: string): void {
    process.stdout.write(`  ${style.dim('◦')} ${style.dim(`${message} (already done)`)}\n`);
  }

  warn(message: string): void {
    process.stdout.write(`  ${style.yellow('!')} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`  ${style.red('✖')} ${message}\n`);
  }

  /** A manual follow-up the script cannot perform. Collected into the final report. */
  manual(message: string): void {
    process.stdout.write(`  ${style.cyan('☞')} ${message}\n`);
  }

  get currentPhase(): string {
    return this.phaseName;
  }
}

export const logger = new Logger();
