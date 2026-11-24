import { execFile } from "node:child_process";
import { ToolError } from "../tools/types";

export type DockerStatus = {
  serverVersion: string;
  os: string;
  cpus: number;
  memoryBytes: number;
};

export interface DockerClient {
  /** Asks the Docker engine who it is. Throws a ToolError that says why if it cannot. */
  status(signal?: AbortSignal): Promise<DockerStatus>;
}

export type Exec = (
  file: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const nodeExec: Exec = (file, args, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { signal, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });

export function createDockerClient(exec: Exec = nodeExec): DockerClient {
  return {
    async status(signal) {
      try {
        const { stdout } = await exec(
          "docker",
          [
            "info",
            "--format",
            "{{.ServerVersion}}|{{.OperatingSystem}}|{{.NCPU}}|{{.MemTotal}}",
          ],
          { signal, timeoutMs: 8000 },
        );
        const [version, os, cpus, memory] = stdout.trim().split("|");
        if (!version) throw new Error("docker info returned nothing");
        return {
          serverVersion: version,
          os: os ?? "unknown",
          cpus: Number(cpus) || 0,
          memoryBytes: Number(memory) || 0,
        };
      } catch (error) {
        const e = error as NodeJS.ErrnoException & {
          stderr?: string;
          killed?: boolean;
        };
        if (e.code === "ENOENT") {
          throw new ToolError(
            "unavailable",
            "Docker is not installed, or it is not on PATH",
            {
              hint: "Install Docker Desktop and open a new terminal.",
              cause: error,
            },
          );
        }
        if (e.name === "AbortError")
          throw new ToolError("aborted", "Stopped while checking Docker");
        if (e.killed || e.code === "ETIMEDOUT") {
          throw new ToolError("timeout", "Docker did not answer in time", {
            hint: "Docker may be starting up. Try again in a moment.",
            cause: error,
          });
        }
        const text = `${e.stderr ?? ""} ${e.message}`;
        if (/daemon|docker_engine|pipe|connect|is the docker/i.test(text)) {
          throw new ToolError(
            "unavailable",
            "Docker is installed but the engine is not running",
            {
              hint: "Start Docker Desktop and wait until it says it is running.",
              cause: (e.stderr ?? e.message).trim().slice(0, 200),
            },
          );
        }
        throw new ToolError("failed", "Docker answered with an error", {
          cause: (e.stderr ?? e.message).trim().slice(0, 200),
        });
      }
    },
  };
}
