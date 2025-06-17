import WebSocket from 'ws';

export interface WebSocketMessage {
  type: string;
  content?: string;
  data?: any;
  channel?: string;
  timestamp?: string;
  source?: string;
  [key: string]: any;
}

export interface WebSocketManagerOptions {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  autoReconnect?: boolean;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private messageQueue: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingResponse: {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;
  
  constructor(private options: WebSocketManagerOptions) {
    this.options = {
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      autoReconnect: true,
      ...options
    };
    
    this.connect();
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.options.url);
      
      this.ws.on('open', () => {
        console.log('WebSocket connected to', this.options.url);
        this.reconnectAttempts = 0;
        this.flushQueue();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`WebSocket disconnected: ${code} - ${reason.toString()}`);
        this.ws = null;
        
        // Reject any pending response
        if (this.pendingResponse) {
          this.pendingResponse.reject(new Error('WebSocket disconnected'));
          this.clearPendingResponse();
        }
        
        if (this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        this.ws = null;
        
        // Reject any pending response
        if (this.pendingResponse) {
          this.pendingResponse.reject(error);
          this.clearPendingResponse();
        }
      });

    } catch (error) {
      console.error('Failed to connect:', error);
      if (this.options.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts!) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.options.reconnectInterval);
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(message);
      }
    }
  }

  private handleMessage(message: string): void {
    // If we're waiting for a response, resolve it with this message
    if (this.pendingResponse) {
      try {
        let parsedMessage = JSON.parse(message);

        if(parsedMessage?.status === 'approved') {
          this.pendingResponse.resolve(parsedMessage);
        } else if(parsedMessage?.status === 'rejected') {
          let feedback = parsedMessage?.feedback || 'yo you rejected the message'
          this.pendingResponse.resolve(JSON.stringify({error: 'code execution rejected', feedback: feedback}));
        } else {
          this.pendingResponse.resolve(JSON.stringify({error: 'Invalid approval response'}));
        }
      } catch (error) {
        // If JSON parsing fails, return the raw message
        console.log('Received plain text response:', message);
        this.pendingResponse.resolve(JSON.stringify({error: 'Failed to parse JSON response'}));
      }
      this.clearPendingResponse();
      return;
    }
    
    // Handle regular messages when not waiting for a response
    try {
      const parsed = JSON.parse(message);
      console.log('Received JSON message:', parsed);
      this.onJsonMessage(parsed);
    } catch (error) {
      console.log('Received plain text message:', message);
      this.onTextMessage(message);
    }
  }

  private clearPendingResponse(): void {
    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timeout);
      this.pendingResponse = null;
    }
  }

  private onJsonMessage(message: any): void {
    // Handle structured JSON messages when not waiting for a response
    if (message.type) {
      console.log(`Handling ${message.type} message:`, message);
    }
  }

  private onTextMessage(message: string): void {
    // Handle plain text messages when not waiting for a response
    console.log(`Handling text message: ${message}`);
    
    if (message.includes('WebSocket') || message.includes('connected') || message.includes('established')) {
      console.log('Connection confirmation received');
    }
  }

  public send(message: string, title: string): boolean {
    let messageItem = {
        id: Date.now().toString(),
        title: title || 'Welcome my guy to the notification app!',
        body: message,
        timestamp: Date.now(),
        priority: 'normal',
        sender: 'Test Client'
    }
    let messageStr = JSON.stringify(messageItem);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(messageStr);
        return true;
      } catch (error) {
        console.error('Failed to send message:', error);
        this.messageQueue.push(messageStr);
        return false;
      }
    } else {
      console.log('WebSocket not connected, queuing message');
      this.messageQueue.push(messageStr);
      return false;
    }
  }

  public async sendAndWaitForApproval(messageObject: any, timeout: number = 30000): Promise<any> {
    // Check if we're already waiting for a response
    if (this.pendingResponse) {
      throw new Error('Already waiting for a response');
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.clearPendingResponse();
        reject(new Error('Response timeout'));
      }, timeout);

      // Store the pending response
      this.pendingResponse = {
        resolve,
        reject,
        timeout: timeoutId
      };

      // Send the message object directly
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(messageObject));
        } catch (error) {
          this.clearPendingResponse();
          reject(error);
        }
      } else {
        this.clearPendingResponse();
        reject(new Error('WebSocket not connected'));
      }
    });
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public getConnectionState(): string {
    if (!this.ws) return 'DISCONNECTED';
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  public disconnect(): void {
    this.options.autoReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Clean up any pending response
    if (this.pendingResponse) {
      this.pendingResponse.reject(new Error('WebSocket disconnected'));
      this.clearPendingResponse();
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public reconnect(): void {
    this.disconnect();
    this.options.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.connect();
  }
}