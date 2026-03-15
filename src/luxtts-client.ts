import fetch from 'node-fetch';

export class LuxTTSClient {
    private baseUrl: string;

    constructor(baseUrl: string = 'http://localhost:8099') {
        this.baseUrl = baseUrl;
    }

    /**
     * Convert text to speech via LuxTTS server.
     * Returns raw WAV buffer (48kHz mono).
     */
    async synthesize(textInput: string, options?: {
        numSteps?: number;
        tShift?: number;
        speed?: number;
    }): Promise<Buffer> {
        // Pad very short text to avoid model errors
        const text = textInput.length < 5 ? textInput + '...' : textInput;
        // Strip emoji that the model can't pronounce
        const cleanText = text.replace(/[\u{1F600}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
        if (!cleanText) throw new Error('No speakable text after cleanup');
        
        const response = await fetch(`${this.baseUrl}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: cleanText,
                num_steps: options?.numSteps ?? 4,
                t_shift: options?.tShift ?? 0.9,
                speed: options?.speed ?? 1.0,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`LuxTTS error ${response.status}: ${err}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    /**
     * Check if the LuxTTS server is healthy and ready.
     */
    async isHealthy(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            if (!response.ok) return false;
            const data = await response.json() as any;
            return data.model_loaded && data.prompt_loaded;
        } catch {
            return false;
        }
    }
}
