const sh = require('shell-tag');
const AWS = require('aws-sdk');
const delay = require('delay');
const path = require('path');
const fs = require('fs');

class EBDeploy {
  constructor (options = {}) {
    this.options = options;
    const config = { region: this.region };

    if (this.accessKeyId && this.secretAccessKey) {
      config.credentials = new AWS.Credentials(this.accessKeyId, this.secretAccessKey, this.sessionToken);
    }

    AWS.config.update(config);

    this.s3 = new AWS.S3();
    this.eb = new AWS.ElasticBeanstalk();
  }

  async deploy () {
    console.log('Deploying application');
    this.startTime = new Date();

    try {
      if (this.options.useExistingAppVersion && await this.appVersionExists()) {
        console.log(`Using existing version '${this.versionLabel}'`);
        await this.updateEnvironment(this.versionLabel);
      } else {
        if (!await this.bucketExists()) {
          await this.createBucket();
        }

        let zipFile;
        if (this.options.zipFile) {
          zipFile = path.resolve(this.options.zipFile);
        } else {
          zipFile = this.createZip();
        }

        const s3Key = await this.upload(this.archiveName, zipFile);
        const version = await this.createAppVersion(s3Key);

        if (!this.options.onlyCreateAppVersion) {
          await this.updateEnvironment(version);
        }
      }

      if (this.options.waitUntilDeployed) {
        await this.waitUntilDeployed();
      }

      this.cleanup();

      console.log(`Application ${this.options.applicationName} (${this.versionLabel}) deployed in ${this.environmentName} environment.`);
    } catch (e) {
      console.error(e.message || e);
      process.exit(1);
    }
  }

  async appVersionExists () {
    const response = await this.eb.describeApplicationVersions({
      ApplicationName: this.options.applicationName,
      VersionLabels: [ this.versionLabel ]
    }).promise();

    if (response) {
      return response.ApplicationVersions.length > 0;
    }
  }

  async bucketExists () {
    try {
      await this.s3.headBucket({
        Bucket: this.options.bucket
      }).promise();
    } catch (e) {
      if (e.code === 'NotFound') {
        return false;
      } else {
        throw e;
      }
    }

    return true;
  }

  createBucket () {
    return this.s3.createBucket({
      Bucket: this.options.bucket
    }).promise();
  }

  createZip () {
    const zipFileName = path.resolve(this.archiveName);
    sh`git archive -o ${zipFileName} --format=zip HEAD`;
    return zipFileName;
  }

  async upload (archiveName, file) {
    const key = this.options.bucketPath ? path.join(this.options.bucketPath, archiveName) : `${archiveName}`;

    await this.s3.putObject({
      Bucket: this.options.bucket,
      Body: fs.readFileSync(file),
      Key: key
    }).promise();

    await this.s3.waitFor('objectExists', {
      Bucket: this.options.bucket,
      Key: key
    }).promise();

    return key;
  }

  async createAppVersion (s3Key) {
    const description = this.versionDescription.substring(0, 200);

    const response = await this.eb.createApplicationVersion({
      ApplicationName: this.options.applicationName,
      VersionLabel: this.versionLabel,
      Description: description,
      SourceBundle: {
        S3Bucket: this.options.bucket,
        S3Key: s3Key
      },
      AutoCreateApplication: false
    }).promise();

    return response.ApplicationVersion.VersionLabel;
  }

  updateEnvironment (versionLabel) {
    return this.eb.updateEnvironment({
      EnvironmentName: this.environmentName,
      VersionLabel: versionLabel
    }).promise();
  }

  async waitUntilDeployed () {
    let errors = 0;
    const events = [];

    while (true) {
      const environmentsResponse = await this.eb.describeEnvironments({
        ApplicationName: this.applicationName,
        EnvironmentNames: [ this.environmentName ]
      }).promise();
      const environment = environmentsResponse['Environments'][0];

      const currentEventsResponse = await this.eb.describeEvents({
        EnvironmentName: this.environmentName,
        StartTime: this.startTime
      }).promise();

      currentEventsResponse['Events'].reverse().forEach(event => {
        const message = `${event.EventDate} [${event.Severity}] ${event.Message}`;

        if (!events.includes(message)) {
          events.push(message);

          if (event.Severity === 'ERROR') {
            errors++;
            console.error(message);
          } else {
            console.log(message);
          }
        }
      });

      if (environment.Status === 'Ready') {
        break;
      }

      await delay(5000);
    }

    if (errors > 0) {
      throw new Error('Deployment failed.');
    }
  }

  cleanup () {
    if (!this.options.skipCleanup) {
      sh`git clean -fd`;
    }
  }

  get region () {
    return this.options.region || process.env['AWS_DEFAULT_REGION'] || 'eu-central-1';
  }

  get versionLabel () {
    this._versionLabel = this._versionLabel || this.options.versionLabel || process.env['ELASTIC_BEANSTALK_LABEL'] || `sha-${this.sha}-${Date.now()}`;
    return this._versionLabel;
  }

  get versionDescription () {
    return this.options.versionDescription || process.env['ELASTIC_BEANSTALK_DESCRIPTION'] || this.commitMsg;
  }

  get environmentName () {
    return this.options.environmentName || process.env['ELASTIC_BEANSTALK_ENVIRONMENT'];
  }

  get accessKeyId () {
    return this.options.accessKeyId || process.env['AWS_ACCESS_KEY_ID'];
  }

  get secretAccessKey () {
    return this.options.secretAccessKey || process.env['AWS_SECRET_ACCESS_KEY'];
  }

  get sessionToken () {
    return this.options.sessionToken || process.env['AWS_SESSION_TOKEN'];
  }

  get sha () {
    this._sha = this._sha || process.env['GIT_SHA'] || sh`git rev-parse --short HEAD`.trim();
    return this._sha;
  }

  get commitMsg () {
    this._commitMsg = this._commitMsg || sh`git log ${this.sha} -n 1 --pretty=%B`.trim();
    return this._commitMsg;
  }

  get archiveName () {
    return `${this.versionLabel}.zip`;
  }
}

module.exports = EBDeploy;
