/** Minimal SMTP server: just enough for nodemailer to complete a session. */
import net from 'node:net';

export interface SmtpStub {
  port: number;
  received: { to: string[]; messageId: string | null; jobHeader: string | null }[];
  close: () => Promise<void>;
}

export function startSmtpStub(port: number): Promise<SmtpStub> {
  const received: SmtpStub['received'] = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let dataLines: string[] = [];
    let rcpt: string[] = [];

    socket.write('220 stub ESMTP ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            const body = dataLines.join('\n');
            const messageId = /^Message-ID:\s*(.+)$/im.exec(body)?.[1]?.trim() ?? null;
            const jobHeader = /^X-Scheduler-Job-Id:\s*(.+)$/im.exec(body)?.[1]?.trim() ?? null;
            received.push({ to: [...rcpt], messageId, jobHeader });
            rcpt = [];
            dataLines = [];
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-stub\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          rcpt.push(/<([^>]+)>/.exec(line)?.[1] ?? line);
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (upper === 'RSET') {
          rcpt = [];
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });

    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        received,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}
