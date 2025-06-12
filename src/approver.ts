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
        
        if (this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        this.ws = null;
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
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(message);
      console.log('Received JSON WebSocket message:', parsed);
      // Handle JSON messages here
      this.onJsonMessage(parsed);
    } catch (error) {
      // If JSON parsing fails, treat as plain text
      console.log('Received plain text WebSocket message:', message);
      // Handle plain text messages here
      this.onTextMessage(message);
    }
  }

  private onJsonMessage(message: any): void {
    // Handle structured JSON messages
    // You can add custom logic here based on message type
    if (message.type) {
      console.log(`Handling ${message.type} message:`, message);
    }
  }

  private onTextMessage(message: string): void {
    // Handle plain text messages
    console.log(`Handling text message: ${message}`);
    
    // Common plain text responses from WebSocket servers
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

        this.ws.send(JSON.stringify(messageItem));
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