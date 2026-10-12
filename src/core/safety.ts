/** Caracteres invisibles o de dirección de texto que sirven para esconder instrucciones o falsear código. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g;

/** Quita caracteres de control, invisibles y de cambio de dirección. */
export function stripHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

const INJECTION: { re: RegExp; why: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|context)\b/i, why: "pide ignorar las instrucciones anteriores" },
  { re: /\b(ignora|olvida|descarta)\b[^.\n]{0,40}\b(instrucciones|indicaciones|reglas)\b/i, why: "pide ignorar las instrucciones anteriores" },
  { re: /\byou are now\b|\bahora eres\b|\bact as (an? )?(?!example)/i, why: "intenta cambiar el papel de la IA" },
  { re: /\b(reveal|show|print|repeat|leak)\b[^.\n]{0,30}\b(system|hidden|secret)\b[^.\n]{0,20}\b(prompt|instructions?)\b/i, why: "intenta sacar las instrucciones internas" },
  { re: /<\/?\s*(system|assistant|instructions?|tool_call|function_calls?)\s*>/i, why: "imita etiquetas del sistema" },
  { re: /\b(do not|don't|never)\b[^.\n]{0,25}\b(tell|inform|mention|alert)\b[^.\n]{0,20}\b(the )?user\b/i, why: "pide ocultar cosas al usuario" },
  { re: /\b(send|post|upload|exfiltrate|forward)\b[^.\n]{0,60}\b(api[_ -]?keys?|passwords?|tokens?|secrets?|credentials?|\.env|ssh)\b/i, why: "pide enviar claves o credenciales" },
  { re: /\b(envía|manda|sube)\b[^.\n]{0,60}\b(claves?|contraseñas?|tokens?|credenciales)\b/i, why: "pide enviar claves o credenciales" },
];

/** Motivos por los que un texto descargado parece intentar dar órdenes a la IA (vacío = nada raro). */
export function injectionFindings(text: string): string[] {
  const why = new Set<string>();
  for (const { re, why: w } of INJECTION) if (re.test(text)) why.add(w);
  return [...why];
}

export interface RiskyFinding {
  severity: "high" | "medium";
  message: string;
}

const RISKY: { re: RegExp; severity: RiskyFinding["severity"]; message: string }[] = [
  { re: /\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, severity: "high", message: "descarga un script y lo ejecuta sin revisarlo (curl | sh)" },
  { re: /\b(base64\s+(-d|--decode)|atob\s*\(|base64_decode\s*\()[^\n]*(\|\s*(ba)?sh|eval|exec)/i, severity: "high", message: "decodifica texto oculto y lo ejecuta" },
  { re: /\beval\s*\(\s*(base64_decode|gzinflate|str_rot13|atob)/i, severity: "high", message: "ejecuta código ofuscado" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*|\.\.?)(\s|$|\/\*)/i, severity: "high", message: "borra carpetas completas (rm -rf)" },
  { re: /\b(mkfs(\.\w+)?|dd\s+if=|fdisk|wipefs)\b|>\s*\/dev\/(sd|nvme|disk)/i, severity: "high", message: "puede formatear o sobrescribir discos" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:/, severity: "high", message: "bomba de procesos (fork bomb)" },
  { re: /\b(powershell|pwsh)\b[^\n]*(-enc(odedcommand)?\b|iex\b|Invoke-Expression)/i, severity: "high", message: "ejecuta comandos de PowerShell codificados" },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\b/, severity: "medium", message: "da permisos totales a todos (chmod 777)" },
  { re: /\bsudo\b/, severity: "medium", message: "se ejecuta con permisos de administrador (sudo)" },
  { re: /(~|\$HOME|\/home\/[\w.-]+)\/\.(ssh|aws|gnupg|config\/gcloud)|\bid_(rsa|ed25519)\b|\/etc\/(passwd|shadow)/i, severity: "high", message: "toca claves o datos privados del equipo" },
  { re: /\bgit\s+config\s+--global\b|\bnpm\s+config\s+set\b[^\n]*registry|\bpip\s+config\s+set\b[^\n]*index/i, severity: "medium", message: "cambia la configuración global de tus herramientas" },
  { re: /\b(npm|pnpm|yarn)\s+(i|install|add)\s+-g\b|\bpip3?\s+install\b[^\n]*--(break-system-packages|user)\b/, severity: "medium", message: "instala algo a nivel global del equipo" },
  { re: /\bcrontab\b|\bsystemctl\s+(enable|start)\b|\bschtasks\b/i, severity: "medium", message: "programa tareas que se ejecutan solas" },
];

/** Avisos sobre un fragmento de código o comando antes de copiarlo o insertarlo. */
export function riskyCode(code: string): RiskyFinding[] {
  const out: RiskyFinding[] = [];
  const text = stripHidden(code);
  for (const r of RISKY) if (r.re.test(text) && !out.some((o) => o.message === r.message)) out.push({ severity: r.severity, message: r.message });
  if (code !== text) out.push({ severity: "high", message: "contiene caracteres invisibles que pueden esconder otra cosa" });
  return out;
}
