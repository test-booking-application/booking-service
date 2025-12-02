pipeline {
    agent {
        kubernetes {
            yaml '''
apiVersion: v1
kind: Pod
metadata:
  labels:
    jenkins: agent
spec:
  serviceAccountName: jenkins
  containers:
  - name: node
    image: node:18-alpine
    command:
    - cat
    tty: true
  - name: docker
    image: docker:dind
    command:
    - cat
    tty: true
    securityContext:
      privileged: true
    volumeMounts:
      - name: dind-storage
        mountPath: /var/lib/docker
  - name: trivy
    image: aquasec/trivy:latest
    command:
    - cat
    tty: true
  - name: helm
    image: alpine/helm:latest
    command:
    - cat
    tty: true
  - name: aws
    image: amazon/aws-cli:latest
    command:
    - cat
    tty: true
  volumes:
    - name: dind-storage
      emptyDir: {}
'''
        }
    }

    environment {
        // App Config
        APP_NAME = 'booking-service' // Change this per service
        AWS_REGION = 'us-east-1'
        ECR_REGISTRY = '044302809167.dkr.ecr.us-east-1.amazonaws.com'
        IMAGE_URI = "${ECR_REGISTRY}/ticket-booking/${APP_NAME}"
        
        // SonarQube Config
        SONAR_HOST_URL = 'https://sonarcloud.io'
        SONAR_ORG = 'test-booking-application' // Your SonarCloud Organization Key
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    // Capture Git Commit Hash for Tagging
                    env.GIT_COMMIT = sh(script: "git rev-parse --short HEAD", returnStdout: true).trim()
                    env.DOCKER_TAG = "${BUILD_NUMBER}-${env.GIT_COMMIT}"
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                container('node') {
                    sh 'npm ci'
                }
            }
        }

        stage('Lint & Test') {
            steps {
                container('node') {
                    sh 'npm run lint'
                    sh 'npm test'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                container('node') {
                    withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                        sh 'apk add --no-cache openjdk17-jre'
                        sh """
                            npx sonar-scanner \
                            -Dsonar.projectKey=${SONAR_ORG}_${APP_NAME} \
                            -Dsonar.organization=${SONAR_ORG} \
                            -Dsonar.sources=. \
                            -Dsonar.host.url=${SONAR_HOST_URL} \
                            -Dsonar.login=${SONAR_TOKEN}
                        """
                    }
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                container('docker') {
                    script {
                        // Start Docker daemon and wait for it to be ready
                        sh '''
                            dockerd-entrypoint.sh &
                            sleep 10
                            while ! docker info > /dev/null 2>&1; do
                                echo "Waiting for Docker daemon to start..."
                                sleep 2
                            done
                            echo "Docker daemon is ready"
                        '''
                        sh "docker build -t ${IMAGE_URI}:${DOCKER_TAG} ."
                        sh "docker tag ${IMAGE_URI}:${DOCKER_TAG} ${IMAGE_URI}:latest"
                    }
                }
            }
        }

        stage('Security Scan (Trivy)') {
            steps {
                container('docker') {
                    script {
                        // Install Trivy in the docker container
                        sh '''
                            apk add --no-cache wget tar
                            wget -q https://github.com/aquasecurity/trivy/releases/download/v0.48.0/trivy_0.48.0_Linux-64bit.tar.gz
                            tar zxf trivy_0.48.0_Linux-64bit.tar.gz
                            mv trivy /usr/local/bin/
                            chmod +x /usr/local/bin/trivy
                        '''
                        
                        // Export Docker image to tarball to avoid Docker API version issues
                        sh "docker save ${IMAGE_URI}:${DOCKER_TAG} -o /tmp/image.tar"
                        
                        // Scan the tarball
                        sh "trivy image --input /tmp/image.tar --severity CRITICAL --exit-code 1 --no-progress"
                        sh "trivy image --input /tmp/image.tar --severity HIGH,CRITICAL --no-progress > trivy-report.txt"
                        
                        // Clean up
                        sh "rm /tmp/image.tar"
                    }
                }
            }
        }

        stage('Push to ECR') {
            steps {
                container('docker') {
                    withCredentials([usernamePassword(credentialsId: 'aws-ecr-creds', passwordVariable: 'ECR_PASSWORD', usernameVariable: 'ECR_USERNAME')]) {
                        script {
                            // Install AWS CLI in docker container
                            sh '''
                                apk add --no-cache python3 py3-pip
                                pip3 install --break-system-packages awscli
                            '''
                            
                            // Login to ECR
                            sh "aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}"
                            
                            // Push images
                            sh "docker push ${IMAGE_URI}:${DOCKER_TAG}"
                            sh "docker push ${IMAGE_URI}:latest"
                        }
                    }
                }
            }
        }

        stage('Deploy to EKS') {
            steps {
                container('helm') {
                    script {
                        // Deploy using Helm
                        // Assumes a 'charts/' directory exists in the repo
                        sh """
                            helm upgrade --install ${APP_NAME} ./charts/${APP_NAME} \
                            --namespace dev --create-namespace \
                            --set image.repository=${IMAGE_URI} \
                            --set image.tag=${DOCKER_TAG}
                        """
                    }
                }
            }
        }
    }

    post {
        always {
            // Archive test results and Trivy report
            archiveArtifacts artifacts: 'trivy-report.txt', allowEmptyArchive: true
            // junit 'test-results.xml' 
        }
        success {
            echo "✅ Pipeline succeeded! Deployed ${APP_NAME}:${DOCKER_TAG}"
        }
        failure {
            echo "❌ Pipeline failed."
        }
    }
}
