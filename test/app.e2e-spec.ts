import './../src/config/load-env';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

type HealthResponse = {
  status: 'ok';
  backend: boolean;
  database: boolean;
  timestamp: string;
};

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }: { body: HealthResponse }) => {
        expect(body).toMatchObject({
          status: 'ok',
          backend: true,
          database: true,
        });
        expect(typeof body.timestamp).toBe('string');
      });
  });

  afterEach(async () => {
    await app?.close();
  });
});
