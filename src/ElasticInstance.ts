import tmp from 'tmp';
import { ChildProcess, SpawnOptions } from 'child_process';
import spawnChild from 'cross-spawn';
import ElasticBinary from './util/ElasticBinary';
import path from 'path';
import fetch from 'node-fetch'; // если ты используешь Node <18

export interface ElasticInstanceOpts {
  port?: number;
  ip?: string;
  dbPath?: string;
  tmpDir?: tmp.DirResult;
  args?: string[];
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

export default class ElasticInstance {
  static childProcessList: ChildProcess[] = [];
  opts: ElasticInstanceOpts;
  childProcess: ChildProcess | null;
  killerProcess: ChildProcess | null;
  isInstanceReady: boolean = false;
  instanceReady: () => void = () => {};
  instanceFailed: (err: any) => void = () => {};

  constructor(opts: ElasticInstanceOpts) {
    this.opts = opts;
    this.childProcess = null;
    this.killerProcess = null;
  }

  static async run(opts: ElasticInstanceOpts): Promise<any> {
    const instance = new this(opts);
    return await instance.run();
  }

  async run(): Promise<this> {
    const launch = new Promise((resolve, reject) => {
      this.instanceReady = () => {
        this.isInstanceReady = true;
        resolve({ ...this.childProcess });
      };
      this.instanceFailed = (err: any) => {
        if (this.killerProcess) this.killerProcess.kill();
        reject(err);
      };
    });

    const binaryHandler = new ElasticBinary();
    const elasticBin = await binaryHandler.getElasticsearchPath();
    this.childProcess = this._launchElasticsearch(elasticBin);
    // this.killerProcess = this._launchKiller(process.pid, this.childProcess.pid);

    this._waitForElastic();

    await launch;
    return this;
  }

  async kill(): Promise<ElasticInstance> {
    if (this.childProcess && !this.childProcess.killed) {
      await new Promise((resolve) => {
        if (this.childProcess) {
          this.childProcess.once(`exit`, () => {
            resolve(undefined);
          });
          this.childProcess.kill();
        }
      });
    } else {
    }
    if (this.killerProcess && !this.killerProcess.killed) {
      await new Promise((resolve) => {
        if (this.killerProcess) {
          this.killerProcess.once(`exit`, () => {
            resolve(undefined);
          });
          this.killerProcess.kill();
        }
      });
    } else {
    }
    return this;
  }

  parseCmdArgs(): string[] {
    const { port, ip, dbPath, args } = this.opts;
    const result: string[] = [];

    if (ip) result.push('-E', `network.host=${ip}`);
    if (port) result.push('-E', `http.port=${port}`);
    if (dbPath) {
      result.push('-E', `path.data=${path.resolve(dbPath, 'path')}`);
      result.push('-E', `path.logs=${path.resolve(dbPath, 'logs')}`);
    }
    if (args && Array.isArray(args)) {
      result.push(...args);
    }

    return result;
  }

  /**
   * Actually launch elasticsearch
   * @param elasticBin The binary to run
   */
  _launchElasticsearch(elasticBin: string): ChildProcess {
    const spawnOpts: SpawnOptions = {
      stdio: 'pipe',
      env: {
        ...process.env,
        ...(this.opts.env || {}),
      },
    };

    const childProcess = spawnChild(elasticBin, this.parseCmdArgs(), spawnOpts);

    if (childProcess.stderr) {
      childProcess.stderr.on('data', this.stderrHandler.bind(this));
    }
    if (!childProcess.stdout) {
      console.log('[DEBUG] stdout is null');
    } else {
      console.log('[DEBUG] stdout is connected');
      childProcess.stdout.on('data', this.stdoutHandler.bind(this));
    }

    childProcess.on('close', this.closeHandler.bind(this));
    childProcess.on('error', this.errorHandler.bind(this));
    childProcess.on('exit', (code, signal) => {
      console.log(`[ES EXIT] code=${code} signal=${signal}`);
    });

    return childProcess;
  }

  errorHandler(err: string): void {
    console.error(err);
    this.instanceFailed(err);
  }

  /**
   * Write the CLOSE event to the debug function
   * @param code The Exit code
   */
  closeHandler(code: number): void {
    // this.debug(`CLOSE: ${code}`);
    console.log(`CLOSE: ${code}`);
  }

  /**
   * Write STDERR to debug function
   * @param message The STDERR line to write
   */
  stderrHandler(message: string | Buffer): void {
    console.error('[ES STDERR]', message.toString());
  }

  stdoutHandler(message: string | Buffer): void {
    const line: string = message.toString();
    // console.log('[ES STDOUT]', line);

    if (/started/i.test(line)) {
      this.instanceReady();
    }
  }
  private _waitForElastic(): void {
    const url = `http://${this.opts.ip}:${this.opts.port}`;
    const maxAttempts = 150;
    let attempts = 0;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(url);
        if (res.status === 200) {
          console.log('[ES HTTP] Ready!');
          clearInterval(interval);
          this.instanceReady();
        }
      } catch (_) {
        // server not up yet
      }

      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        this.instanceFailed(new Error('Timeout waiting for Elasticsearch HTTP'));
      }
    }, 200);
  }
}
