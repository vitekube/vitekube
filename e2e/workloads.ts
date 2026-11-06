export const WEB_IMAGE = "busybox:1.37";

const webCommand = ["sh", "-c", "mkdir -p /www && echo ok > /www/index.html && exec httpd -f -p 8080 -h /www"];

export const webDeployment = (name: string, replicas = 1) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name },
  spec: {
    replicas,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        terminationGracePeriodSeconds: 0,
        containers: [{ name: "web", image: WEB_IMAGE, command: webCommand, ports: [{ containerPort: 8080 }] }],
      },
    },
  },
});

export const webService = (name: string) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name },
  spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] },
});

export const job = (
  name: string,
  script: string,
  overrides: Record<string, unknown> = {},
  podSpec: Record<string, unknown> = {}
) => ({
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: { name },
  spec: {
    backoffLimit: 0,
    ...overrides,
    template: {
      spec: {
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 0,
        containers: [{ name: "main", image: WEB_IMAGE, command: ["sh", "-c", script] }],
        ...podSpec,
      },
    },
  },
});

export const pod = (name: string, image: string, command: string[], env: { name: string; value: string }[] = []) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name },
  spec: {
    restartPolicy: "Never",
    terminationGracePeriodSeconds: 0,
    containers: [{ name: "main", image, command, env }],
  },
});
